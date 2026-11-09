// Builds an embed's player when the reader asks for it (#425). Until then a published page
// holds a placeholder and asks nothing of the provider, not even a thumbnail.
//
// Plain and unbundled so it works under every theme, hydrated or not. The providers below are
// a copy of EMBED_PROVIDER_SPECS (gl-admin/lib/blocks-spec/embeds.ts), which
// embedLoader.test.ts compares with this file. Every address is built here from a template
// and a ref that passed its provider's pattern: the markup only ever says which item.
;(function () {
  if (window.__glEmbedsLoaded) return
  window.__glEmbedsLoaded = true

  var SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
  var X_WIDGET = "https://platform.twitter.com/widgets.js"

  var FRAMES = {
    youtube: {
      ref: /^[A-Za-z0-9_-]{11}$/,
      src: function (ref) {
        return "https://www.youtube-nocookie.com/embed/" + ref
      },
      sandbox: SANDBOX,
      referrerPolicy: "strict-origin-when-cross-origin",
      allow: "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen",
    },
    vimeo: {
      ref: /^[0-9]{1,12}(?:\/[0-9a-f]{6,32})?$/,
      src: function (ref) {
        var parts = ref.split("/")
        return "https://player.vimeo.com/video/" + parts[0] + "?dnt=1" + (parts[1] ? "&h=" + parts[1] : "")
      },
      sandbox: SANDBOX,
      referrerPolicy: "strict-origin-when-cross-origin",
      allow: "encrypted-media; picture-in-picture; fullscreen",
    },
    codepen: {
      ref: /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9]{1,16}$/,
      src: function (ref) {
        var parts = ref.split("/")
        return "https://codepen.io/" + parts[0] + "/embed/" + parts[1] + "?default-tab=result"
      },
      sandbox: SANDBOX + " allow-forms allow-modals",
      referrerPolicy: "no-referrer",
      allow: "fullscreen",
    },
    soundcloud: {
      ref: /^[a-z0-9_-]{1,100}(?:\/sets)?\/[a-z0-9_-]{1,200}$/,
      src: function (ref) {
        return "https://w.soundcloud.com/player/?url=" + encodeURIComponent("https://soundcloud.com/" + ref)
      },
      sandbox: SANDBOX,
      referrerPolicy: "no-referrer",
      allow: "encrypted-media",
    },
    spotify: {
      ref: /^(?:track|album|playlist|episode|show)\/[A-Za-z0-9]{22}$/,
      src: function (ref) {
        return "https://open.spotify.com/embed/" + ref
      },
      sandbox: SANDBOX,
      referrerPolicy: "no-referrer",
      allow: "encrypted-media; fullscreen; picture-in-picture",
    },
  }

  var X_REF = /^[0-9]{1,25}$/

  function showRegion(frame, label) {
    frame.classList.add("is-loaded")
    frame.setAttribute("role", "region")
    frame.setAttribute("aria-label", label)
    frame.removeAttribute("data-embed-provider")
    frame.removeAttribute("data-embed-ref")
    frame.textContent = ""
  }

  function loadFrame(frame, spec, ref, label) {
    var iframe = document.createElement("iframe")
    iframe.title = label
    iframe.setAttribute("loading", "lazy")
    iframe.setAttribute("referrerpolicy", spec.referrerPolicy)
    // Set before src: a frame must never load without its sandbox.
    iframe.setAttribute("sandbox", spec.sandbox)
    if (spec.allow) iframe.setAttribute("allow", spec.allow)
    iframe.src = spec.src(ref)
    showRegion(frame, label)
    frame.appendChild(iframe)
    iframe.focus()
  }

  var widget = null

  // X's script, requested once, and only after someone asks for a post.
  function loadXWidget() {
    if (widget) return widget
    widget = new Promise(function (resolve, reject) {
      var script = document.createElement("script")
      script.src = X_WIDGET
      script.async = true
      script.onload = function () {
        if (window.twttr && window.twttr.ready) window.twttr.ready(resolve)
        else reject(new Error("no widget"))
      }
      script.onerror = reject
      document.head.appendChild(script)
    })
    widget.catch(function () {
      widget = null
    })
    return widget
  }

  function loadPost(frame, ref, label) {
    var note = frame.querySelector(".embed-note")
    var button = frame.querySelector("[data-embed-load]")
    if (button) button.disabled = true
    loadXWidget()
      .then(function (twttr) {
        showRegion(frame, label)
        frame.setAttribute("tabindex", "-1")
        frame.focus()
        return twttr.widgets.createTweet(ref, frame, { dnt: true }).then(function (element) {
          if (!element) throw new Error("no post")
        })
      })
      .catch(function () {
        if (button && button.isConnected) {
          button.disabled = false
          if (note) note.textContent = "This post couldn't be loaded. Try again."
          return
        }
        frame.textContent = "This post couldn't be loaded."
      })
  }

  document.addEventListener("click", function (event) {
    var target = event.target
    var button = target && target.closest ? target.closest("[data-embed-load]") : null
    if (!button) return
    var frame = button.closest("[data-embed-provider]")
    if (!frame) return
    var provider = frame.getAttribute("data-embed-provider")
    var ref = frame.getAttribute("data-embed-ref") || ""
    var label = frame.getAttribute("data-embed-label") || "Embedded content"
    if (provider === "x") {
      if (X_REF.test(ref)) loadPost(frame, ref, label)
      return
    }
    var spec = Object.prototype.hasOwnProperty.call(FRAMES, provider) ? FRAMES[provider] : null
    if (spec && spec.ref.test(ref)) loadFrame(frame, spec, ref, label)
  })
})()
