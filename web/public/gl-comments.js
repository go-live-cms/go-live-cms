// Reader comments, enhanced (#525, docs/design/reader-comments.md 11.4 and 11.6).
//
// Plain and unbundled, like gl-embeds.js: a same-origin <script src defer>, never inline, so the
// public CSP is untouched. It only enhances. On a post page the comment form works without it
// (the /gl-comments endpoint answers a redirect back with ?commented=, 9.4); with it the form
// posts with fetch (Accept: application/json), says the outcome in its status region, shows a
// published comment in place (a pending one as "Awaiting moderation · only you can see this",
// until reload), moves under a comment to reply, and counts characters. The reader pages
// (/comments/confirm, /comments/unsubscribe, /comments/your-data) need it: their link's token is
// in the #fragment, which never reaches a server, and it is spent by a button, never on load.
//
// Everything a reader or the API wrote goes in with textContent or an attribute, never as markup.
// The link rule and the avatar colours are copies of src/lib/discussion.ts (readerCommentRuns)
// and src/lib/bylines.ts (avatarColor); glComments.test.ts compares them.
;(function () {
  if (window.__glCommentsLoaded) return
  window.__glCommentsLoaded = true

  var BODY_MIN = 2
  var BODY_MAX = 4000
  var NAME_MAX = 60
  var LINK_REL = "nofollow ugc noopener"
  var AVATAR_COLORS = ["#6550b9", "#2a7e3b", "#a1305a", "#0b68b8", "#9a4a12", "#5b5a55"]
  var SVG = "http://www.w3.org/2000/svg"

  // The API's refusals in the reader's words (src/lib/commentWrites.ts has the same for the
  // pages without scripts).
  var REASONS = {
    comments_closed: "Comments on this post are closed.",
    comments_off: "Comments are off for this post.",
    not_found: "This post isn't available.",
    parent_not_found: "The comment you replied to isn't available any more. Post yours as a new comment.",
    comments_busy: "Too many comments are waiting for review on this post. Try again later.",
    invalid_token: "This link has been used or has expired.",
  }
  var FIELD_REASONS = {
    name_required: "Enter your name.",
    name_too_long: "Your name is too long: 60 characters at most.",
    name_invalid: "Your name must be one line of plain text.",
    body_too_short: "Write at least 2 characters.",
    body_too_long: "Your comment is too long: 4,000 characters at most.",
    body_invalid: "Your comment has characters that can't be shown. Remove them and try again.",
  }
  var UNAVAILABLE = "The site couldn't take your comment just now. Try again in a moment."
  var TOO_FAST = "You’re commenting faster than this site allows. Wait a minute, then post it again. Your text is still here."

  // --- small helpers ----------------------------------------------------------------------

  function length(text) {
    return Array.from(text).length
  }
  function formatCount(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  }
  function avatarColor(key) {
    var n = 0
    for (var ch of String(key)) n = (n * 31 + (ch.codePointAt(0) || 0)) >>> 0
    return AVATAR_COLORS[n % AVATAR_COLORS.length]
  }
  function initial(name) {
    var ch = String(name || "").trim().charAt(0)
    return ch ? ch.toUpperCase() : "?"
  }
  function h(tag, attrs, children) {
    var node = document.createElement(tag)
    for (var name in attrs || {}) {
      if (attrs[name] !== null && attrs[name] !== undefined && attrs[name] !== false) node.setAttribute(name, attrs[name] === true ? "" : String(attrs[name]))
    }
    append(node, children)
    return node
  }
  function append(node, children) {
    ;[].concat(children === undefined ? [] : children).forEach(function (child) {
      if (child === null || child === undefined || child === false) return
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child)
    })
    return node
  }
  function icon(kind) {
    var svg = document.createElementNS(SVG, "svg")
    var attrs = { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }
    for (var name in attrs) svg.setAttribute(name, attrs[name])
    var paths = kind === "ok" ? ["M20 6 9 17l-5-5"] : ["M12 8v4", "M12 16h.01"]
    if (kind !== "ok") {
      var circle = document.createElementNS(SVG, "circle")
      circle.setAttribute("cx", "12")
      circle.setAttribute("cy", "12")
      circle.setAttribute("r", "9")
      svg.appendChild(circle)
    }
    paths.forEach(function (d) {
      var path = document.createElementNS(SVG, "path")
      path.setAttribute("d", d)
      svg.appendChild(path)
    })
    return svg
  }

  // A comment's line as text and links (5.4): readerCommentRuns in src/lib/discussion.ts.
  var LINK = /\bhttps?:\/\/[^\s<>"'`]+/gi
  var CLOSERS = { ")": "(", "]": "[", "}": "{" }
  function trimLink(link) {
    while (link !== "") {
      var last = link[link.length - 1]
      if (".,;:!?".indexOf(last) !== -1) {
        link = link.slice(0, -1)
        continue
      }
      var open = CLOSERS[last]
      if (open && link.split(open).length - 1 < link.split(last).length - 1) {
        link = link.slice(0, -1)
        continue
      }
      return link
    }
    return link
  }
  function runs(line) {
    var out = []
    var last = 0
    var match
    LINK.lastIndex = 0
    while ((match = LINK.exec(line)) !== null) {
      var link = trimLink(match[0])
      if (link.length <= link.indexOf("://") + 3) continue
      if (match.index > last) out.push({ text: line.slice(last, match.index) })
      out.push({ text: link, href: link })
      last = match.index + link.length
    }
    if (last < line.length) out.push({ text: line.slice(last) })
    return out
  }
  // The comment's text as the server renders it (commentParagraphs): <p> per blank line, <br> per newline.
  function commentText(body) {
    var text = h("div", { class: "comment-text" })
    String(body)
      .replace(/\r\n?/g, "\n")
      .trim()
      .split(/\n{2,}/)
      .filter(function (block) {
        return block.replace(/^\n+|\n+$/g, "") !== ""
      })
      .forEach(function (block) {
        var p = h("p")
        block
          .replace(/^\n+|\n+$/g, "")
          .split("\n")
          .forEach(function (line, i) {
            if (i > 0) p.appendChild(h("br"))
            runs(line).forEach(function (run) {
              p.appendChild(run.href ? h("a", { href: run.href, rel: LINK_REL }, run.text) : document.createTextNode(run.text))
            })
          })
        text.appendChild(p)
      })
    return text
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(
      function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (json) {
            return { status: response.status, body: json && typeof json === "object" ? json : {} }
          })
      },
      function () {
        return { status: 0, body: {} }
      },
    )
  }

  // --- the comment form (11.2, 11.4) ------------------------------------------------------

  function enhanceForm(form) {
    var section = form.closest(".comments") || document
    var status = form.querySelector(".comment-status")
    var title = form.querySelector("#comment-form-title")
    var button = form.querySelector('button[type="submit"]')
    var counter = form.querySelector(".comment-count")
    var fields = {
      body: form.querySelector('[name="comment"]'),
      name: form.querySelector('[name="name"]'),
      email: form.querySelector('[name="email"]'),
    }
    var homeTitle = title ? title.textContent : ""
    var home = document.createComment("comment-form")
    form.parentNode.insertBefore(home, form)
    var replying = null
    var sending = false
    form.noValidate = true
    if (form.querySelector('[name="parent_id"]')) {
      // Rendered for ?replyto=: Cancel goes back to a new comment without a reload.
      var target = form.querySelector(".comment-form-replying a[href^='#']")
      replying = { id: form.querySelector('[name="parent_id"]').value, name: target ? target.textContent : "", article: null, rendered: true }
      homeTitle = "Leave a comment"
    }

    function count() {
      if (!counter || !fields.body) return
      var n = length(fields.body.value)
      counter.textContent = formatCount(n) + " / " + formatCount(BODY_MAX)
      counter.classList.toggle("is-over", n > BODY_MAX)
    }
    if (fields.body) fields.body.addEventListener("input", count)
    count()

    function notice(kind, heading, text) {
      while (status.firstChild) status.removeChild(status.firstChild)
      if (!heading) return
      status.appendChild(h("div", { class: "comment-notice " + (kind === "ok" ? "is-success" : "is-error") }, [icon(kind), h("div", {}, [h("b", {}, heading), h("p", {}, text)])]))
    }

    function clearErrors() {
      Object.keys(fields).forEach(function (key) {
        var input = fields[key]
        if (!input) return
        input.removeAttribute("aria-invalid")
        var error = document.getElementById(input.id + "-error")
        if (error) error.remove()
        var described = (input.getAttribute("aria-describedby") || "")
          .split(/\s+/)
          .filter(function (id) {
            return id && id !== input.id + "-error"
          })
          .join(" ")
        if (described) input.setAttribute("aria-describedby", described)
        else input.removeAttribute("aria-describedby")
      })
    }

    // Each field tied to its message, the summary in the status region, focus on the first (11.5).
    function fieldErrors(problems) {
      var keys = Object.keys(problems)
      notice("error", "Your comment wasn’t posted", keys.length === 1 ? "Fix the field marked below, then post it again." : "Fix the " + keys.length + " fields marked below, then post it again.")
      var first = null
      ;["body", "name", "email"].forEach(function (key) {
        var input = fields[key]
        if (!problems[key] || !input) return
        var id = input.id + "-error"
        input.setAttribute("aria-invalid", "true")
        input.setAttribute("aria-describedby", ((input.getAttribute("aria-describedby") || "") + " " + id).trim())
        var after = key === "body" && counter ? counter : input
        after.insertAdjacentElement("afterend", h("p", { class: "comment-error", id: id }, [icon("error"), problems[key]]))
        if (!first) first = input
      })
      if (first) first.focus()
    }

    function validate() {
      var problems = {}
      var body = fields.body ? fields.body.value.trim() : ""
      var name = fields.name ? fields.name.value.trim() : ""
      var email = fields.email ? fields.email.value.trim() : ""
      if (length(body) < BODY_MIN) problems.body = body ? FIELD_REASONS.body_too_short : "Write your comment."
      else if (length(body) > BODY_MAX) problems.body = FIELD_REASONS.body_too_long
      if (!name) problems.name = FIELD_REASONS.name_required
      else if (length(name) > NAME_MAX) problems.name = FIELD_REASONS.name_too_long
      if (!email) problems.email = "Enter your email address."
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.email = "“" + email + "” isn’t a complete email address."
      return problems
    }

    function setParent(id) {
      var input = form.querySelector('[name="parent_id"]')
      if (id === null) {
        if (input) input.remove()
        return
      }
      if (!input) {
        input = h("input", { type: "hidden", name: "parent_id" })
        form.insertBefore(input, form.querySelector('[name="return_to"]'))
      }
      input.value = id
    }

    function replyingLine(name, anchor) {
      var old = form.querySelector(".comment-form-replying")
      if (old) old.remove()
      if (name === null) return
      var cancel = h("a", { href: "#comment-form", "data-reply-cancel": true }, "Cancel")
      cancel.addEventListener("click", function (event) {
        event.preventDefault()
        endReply(true)
      })
      title.insertAdjacentElement("afterend", h("p", { class: "comment-form-replying" }, [h("span", {}, ["Replying to ", h("a", { href: "#" + anchor }, name)]), cancel]))
    }

    function startReply(link) {
      var article = link.closest("article.comment")
      if (!article) return
      var name = (article.querySelector(".comment-author") || {}).textContent || ""
      replying = { id: link.getAttribute("data-reply-to"), name: name, article: article }
      // Under the comment, in its list item.
      article.insertAdjacentElement("afterend", form)
      if (title) title.textContent = "Reply to " + name
      replyingLine(name, article.id)
      setParent(replying.id)
      notice(null)
      if (fields.body) fields.body.focus()
    }

    function endReply(focus) {
      if (!replying) return
      replying = null
      home.parentNode.insertBefore(form, home.nextSibling)
      if (title) title.textContent = homeTitle
      replyingLine(null)
      setParent(null)
      if (focus && fields.body) fields.body.focus()
    }

    section.addEventListener("click", function (event) {
      var link = event.target.closest && event.target.closest("a.comment-reply[data-reply-to]")
      if (link && section.contains(link)) {
        event.preventDefault()
        startReply(link)
      }
    })
    var renderedCancel = form.querySelector("[data-reply-cancel]")
    if (renderedCancel) {
      renderedCancel.addEventListener("click", function (event) {
        event.preventDefault()
        endReply(true)
      })
    }

    // The reader's own comment, in place (11.4): published, or pending until reload.
    function showOwn(id, pending, values, parentId) {
      var anchor = id ? "comment-" + id : null
      var article = h("article", { class: "comment is-own", id: anchor, "aria-labelledby": anchor ? anchor + "-name" : null }, [
        h("span", { class: "avatar", "aria-hidden": "true", style: "background:" + avatarColor(values.name) }, initial(values.name)),
        h("div", { class: "comment-body" }, [
          h("header", { class: "comment-meta" }, [
            h("b", { class: "comment-author", id: anchor ? anchor + "-name" : null }, values.name),
            h("span", {}, [h("time", { datetime: new Date().toISOString() }, "Just now")]),
          ]),
          pending ? h("span", { class: "comment-pending" }, "Awaiting moderation · only you can see this") : null,
          commentText(values.body),
        ]),
      ])
      if (!anchor) article.setAttribute("aria-label", "Your comment")
      var item = h("li", {}, article)
      var parent = parentId ? document.getElementById("comment-" + parentId) : null
      var thread = parent ? parent.closest(".comment-list > li") : null
      if (thread) {
        var replies = thread.querySelector(":scope > .comment-replies")
        if (!replies) {
          replies = h("ol", { class: "comment-replies" })
          var more = thread.querySelector(":scope > .comment-more")
          thread.insertBefore(replies, more)
        }
        replies.appendChild(item)
      } else {
        var list = section.querySelector(".comment-list")
        if (!list) {
          list = h("ol", { class: "comment-list" })
          var empty = section.querySelector(".comments-empty")
          if (empty) empty.replaceWith(list)
          else section.insertBefore(list, home)
        }
        list.appendChild(item)
      }
      if (!pending) {
        var heading = section.querySelector(".comments-title")
        var countEl = heading && heading.querySelector(".comments-count")
        if (countEl) countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1)
        else if (heading) {
          heading.appendChild(document.createTextNode(" "))
          heading.appendChild(h("span", { class: "comments-count" }, "1"))
        }
      }
    }

    function closedTitle() {
      var at = form.getAttribute("data-closes-at")
      var date = at ? new Date(at) : null
      if (!date || isNaN(date.getTime()) || date.getTime() > Date.now()) return "Comments on this post are closed"
      var lang = document.documentElement.lang || undefined
      return "Comments on this post closed on " + date.toLocaleDateString(lang, { month: "long", day: "numeric" })
    }

    function answered(answer, values, parentId) {
      var outcome = answer.body.outcome
      var code = answer.body.code
      if ((answer.status === 201 || answer.status === 202) && (outcome === "published" || outcome === "pending" || outcome === "confirm_email")) {
        endReply(false)
        form.reset()
        count()
        if (outcome === "confirm_email") {
          notice("ok", "Check your email to publish your comment", "We sent a link to the address you gave. Your comment appears once you open it. If nothing arrives in a few minutes, look in your spam folder.")
          return
        }
        showOwn(answer.body.comment_id, outcome === "pending", values, parentId)
        if (outcome === "pending") notice("ok", "Thanks. Your comment is waiting for review", "It shows on the post once a moderator approves it.")
        else notice("ok", "Your comment is published", parentId ? "It’s under the comment you replied to." : "It’s at the end of the comments.")
        return
      }
      if (answer.status === 400 && answer.body.fields && typeof answer.body.fields === "object") {
        var problems = {}
        Object.keys(answer.body.fields).forEach(function (field) {
          var key = field === "body" ? "body" : field === "name" ? "name" : field === "email" ? "email" : null
          if (key) problems[key] = FIELD_REASONS[code] || (key === "email" ? "Enter a complete email address." : "Check this field.")
        })
        if (Object.keys(problems).length) return fieldErrors(problems)
      }
      if (answer.status === 409 && code === "comments_closed") return notice("error", closedTitle(), "Your comment wasn’t posted. Your text is still here if you want to keep it.")
      if (answer.status === 429) return notice("error", "Your comment wasn’t posted", code === "comments_busy" ? REASONS.comments_busy : TOO_FAST)
      if (REASONS[code]) return notice("error", "Your comment wasn’t posted", REASONS[code] + " Your text is still here.")
      notice("error", "Your comment wasn’t posted", UNAVAILABLE + " Your text is still here.")
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault()
      if (sending) return
      clearErrors()
      var problems = validate()
      if (Object.keys(problems).length) return fieldErrors(problems)
      var data = {}
      new FormData(form).forEach(function (value, key) {
        if (typeof value === "string") data[key] = value
      })
      var values = { name: fields.name.value.trim(), body: fields.body.value }
      var parentId = data.parent_id || null
      sending = true
      if (button) button.disabled = true
      form.setAttribute("aria-busy", "true")
      post(form.action, data).then(function (answer) {
        sending = false
        if (button) button.disabled = false
        form.removeAttribute("aria-busy")
        answered(answer, values, parentId)
      })
    })
  }

  // --- the reader pages (11.6) ------------------------------------------------------------

  function readerPage(root) {
    var panel = root.querySelector("[data-reader-panel]")
    var live = root.querySelector("[data-reader-live]")
    var token = new URLSearchParams(location.hash.slice(1)).get("token") || ""

    function say(text) {
      if (live) live.textContent = text
    }
    function show(state, slots, focus) {
      var template = root.querySelector('template[data-reader-state="' + state + '"]')
      if (!template || !panel) return null
      while (panel.firstChild) panel.removeChild(panel.firstChild)
      panel.appendChild(template.content.cloneNode(true))
      fill(panel, slots || {})
      var heading = panel.querySelector("h1")
      if (heading) {
        panel.setAttribute("aria-labelledby", heading.id)
        if (focus) {
          heading.setAttribute("tabindex", "-1")
          heading.focus()
        }
      }
      return panel
    }
    function fill(node, slots) {
      Object.keys(slots).forEach(function (name) {
        node.querySelectorAll('[data-slot="' + name + '"]').forEach(function (target) {
          var value = slots[name]
          if (target.tagName === "A") {
            if (value && typeof value === "object") {
              if (safePath(value.href)) target.setAttribute("href", value.href)
              target.textContent = value.text
            } else if (safePath(value)) target.setAttribute("href", value)
          } else target.textContent = value === null || value === undefined ? "" : String(value)
        })
      })
    }
    // A path on this site (the API's post_url and comment_url): never another host.
    function safePath(value) {
      return typeof value === "string" && /^\/(?!\/)/.test(value) && value.indexOf("\\") === -1
    }
    function onClick(selector, handler) {
      root.addEventListener("click", function (event) {
        var target = event.target.closest && event.target.closest(selector)
        if (target && root.contains(target)) {
          event.preventDefault()
          if (target.disabled) return
          handler(target)
        }
      })
    }
    function busy(button, on) {
      button.disabled = on
      if (on) button.setAttribute("aria-busy", "true")
      else button.removeAttribute("aria-busy")
    }
    // The token wasn't spent by a refusal: Try again shows the button again.
    onClick("[data-reader-retry]", function () {
      show("before", {}, true)
    })
    function failed(answer) {
      if (answer.status === 400 && answer.body.code === "invalid_token") return show("invalid", {}, true)
      var code = answer.body.code
      var reason = answer.status === 429 ? "Too many tries. Wait a minute and try again." : REASONS[code] || "The site couldn't do that just now. Try again in a moment."
      show("error", { reason: reason }, true)
    }

    var kind = root.getAttribute("data-gl-reader")
    // A state the server already rendered (?error=, a discard without scripts): nothing to do.
    if (root.hasAttribute("data-reader-final")) return

    if (kind === "confirm") {
      if (!token) return show("invalid")
      show("before")
      onClick("[data-reader-confirm]", function (button) {
        busy(button, true)
        post("/gl-comments/confirm", { token: token }).then(function (answer) {
          if (answer.status !== 200) {
            busy(button, false)
            return failed(answer)
          }
          var published = answer.body.outcome === "published"
          show(published ? "published" : "pending", { post: answer.body.post_url, comment: answer.body.comment_url }, true)
          var others = Array.isArray(answer.body.others) ? answer.body.others : []
          if (others.length) showOthers(others)
        })
      })
      onClick("[data-reader-other]", function (button) {
        var item = button.closest("li")
        var id = item && item.getAttribute("data-comment-id")
        var action = button.getAttribute("data-reader-other")
        if (!id || !/^[1-9][0-9]*$/.test(id)) return
        item.querySelectorAll("button").forEach(function (b) {
          busy(b, true)
        })
        post("/gl-comments/unconfirmed/" + id, { action: action }).then(function (answer) {
          var done = answer.status === 204 ? "Discarded" : answer.status === 200 ? (answer.body.outcome === "published" ? "Published" : "Waiting for review") : null
          var actions = item.querySelector(".reader-actions")
          if (!done) {
            item.querySelectorAll("button").forEach(function (b) {
              busy(b, false)
            })
            say(answer.status === 404 ? "That comment isn’t waiting any more." : "That didn’t work. Try again in a moment.")
            return
          }
          if (actions) actions.replaceWith(h("span", { class: "meta reader-item-done" }, done))
          say(done + ": " + ((item.querySelector("b") || {}).textContent || "the comment") + ".")
        })
      })
      return
    }

    function showOthers(others) {
      var template = root.querySelector('template[data-reader-state="others"]')
      var row = root.querySelector('template[data-reader-state="other"]')
      if (!template || !row) return
      var block = template.content.cloneNode(true)
      var list = block.querySelector(".reader-list")
      others.forEach(function (other) {
        if (!other || !/^[1-9][0-9]*$/.test(String(other.id))) return
        var item = row.content.cloneNode(true).querySelector("li")
        item.setAttribute("data-comment-id", String(other.id))
        fill(item, { post: { href: other.post_url, text: String(other.post_title || "") }, excerpt: String(other.excerpt || "") })
        item.querySelectorAll("button").forEach(function (b) {
          var label = b.getAttribute("aria-label")
          if (label) b.setAttribute("aria-label", label + " " + String(other.post_title || ""))
        })
        list.appendChild(item)
      })
      panel.appendChild(block)
    }

    if (kind === "unsubscribe") {
      if (!token) return show("invalid")
      show("before")
      onClick("[data-reader-unsubscribe]", function (button) {
        var all = button.getAttribute("data-reader-unsubscribe") === "all"
        busy(button, true)
        post("/gl-comments/unsubscribe", all ? { token: token, all: true } : { token: token }).then(function (answer) {
          if (answer.status !== 204 && answer.status !== 200) {
            busy(button, false)
            return failed(answer)
          }
          show(all ? "done-all" : "done", {}, true)
        })
      })
      return
    }

    if (kind === "your-data") {
      var request = null
      if (!token) {
        show("request")
      } else {
        // Reading the list doesn't spend the link (it works for its hour, 9.2): only Delete does.
        show("loading")
        post("/gl-comments/data", { token: token }).then(function (answer) {
          if (answer.status !== 200) return failed(answer)
          request = answer.body
          showData(request)
        })
      }
      root.addEventListener("submit", function (event) {
        var form = event.target.closest && event.target.closest("form[data-reader-request]")
        if (!form) return
        event.preventDefault()
        var email = form.querySelector('[name="email"]')
        var value = email ? email.value.trim() : ""
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          email.setAttribute("aria-invalid", "true")
          say("Enter the email address you commented with.")
          email.focus()
          return
        }
        var submit = form.querySelector("button")
        busy(submit, true)
        post("/gl-comments/data-request", { email: value }).then(function (answer) {
          busy(submit, false)
          if (answer.status === 202 || answer.status === 200 || answer.status === 204) show("sent", {}, true)
          else failed(answer)
        })
      })
      onClick("[data-reader-delete]", function (button) {
        var item = button.closest("li")
        var id = item && item.getAttribute("data-comment-id")
        if (!id) return
        busy(button, true)
        post("/gl-comments/data/delete", { token: token, comment_id: Number(id) }).then(function (answer) {
          if (answer.status !== 204 && answer.status !== 200) {
            busy(button, false)
            return failed(answer)
          }
          if (request && Array.isArray(request.comments)) {
            request.comments = request.comments.filter(function (c) {
              return String(c && c.id) !== id
            })
          }
          button.replaceWith(h("span", { class: "meta reader-item-done" }, "Deleted"))
          say("Deleted your comment on " + ((item.querySelector("b") || {}).textContent || "the post") + ".")
        })
      })
      onClick("[data-reader-stop-mail]", function (button) {
        busy(button, true)
        post("/gl-comments/data/unsubscribe", { token: token }).then(function (answer) {
          if (answer.status !== 204 && answer.status !== 200) {
            busy(button, false)
            return failed(answer)
          }
          if (request && Array.isArray(request.subscriptions)) request.subscriptions = []
          button.replaceWith(h("span", { class: "meta reader-item-done" }, "Reply emails stopped"))
          say("You won’t get reply emails from this site any more.")
        })
      })
      onClick("[data-reader-download]", function () {
        if (!request) return
        var blob = new Blob([JSON.stringify(request, null, 2)], { type: "application/json" })
        var link = h("a", { href: URL.createObjectURL(blob), download: "my-comments.json" })
        document.body.appendChild(link)
        link.click()
        link.remove()
      })
      onClick("[data-reader-erase-ask]", function () {
        show("erase", { count: countLabel(request), email: commenterEmail(request) }, true)
      })
      onClick("[data-reader-erase-cancel]", function () {
        showData(request)
      })
      onClick("[data-reader-erase]", function (button) {
        busy(button, true)
        post("/gl-comments/data/delete", { token: token }).then(function (answer) {
          if (answer.status !== 204 && answer.status !== 200) {
            busy(button, false)
            return failed(answer)
          }
          show("erased", { email: commenterEmail(request) }, true)
        })
      })
    }

    // The export of 13.2 (#529, api/discussion_privacy.go CommenterExport): {commenter: {email},
    // comments: [{id, post_title, post_url, status, created_at, body}], subscriptions: [...]}.
    // Every status is listed: the reader sees what the site keeps, not only what is shown.
    var STATUS_LABELS = { approved: "Published", pending: "Waiting for review", unconfirmed: "Not confirmed", spam: "Not published", trash: "Not published" }
    function commenterEmail(data) {
      return (data && data.commenter && data.commenter.email) || ""
    }
    function countLabel(data) {
      var n = data && Array.isArray(data.comments) ? data.comments.length : 0
      return n === 0 ? "your comments" : n === 1 ? "your comment" : "your " + n + " comments"
    }
    function showData(data) {
      var node = show("list", { email: commenterEmail(data) }, true)
      var row = root.querySelector('template[data-reader-state="item"]')
      var list = node && node.querySelector(".reader-list")
      if (!list || !row) return
      var comments = Array.isArray(data.comments) ? data.comments : []
      var empty = node.querySelector("[data-reader-empty]")
      if (empty && comments.length === 0) empty.hidden = false
      var stop = node.querySelector("[data-reader-stop-mail]")
      if (stop && Array.isArray(data.subscriptions) && data.subscriptions.length > 0) stop.hidden = false
      comments.forEach(function (comment) {
        if (!comment || !/^[1-9][0-9]*$/.test(String(comment.id))) return
        var item = row.content.cloneNode(true).querySelector("li")
        item.setAttribute("data-comment-id", String(comment.id))
        var when = comment.created_at ? new Date(comment.created_at) : null
        fill(item, {
          post: { href: comment.post_url, text: String(comment.post_title || "") },
          when: when && !isNaN(when.getTime()) ? when.toLocaleDateString(document.documentElement.lang || undefined, { month: "short", day: "numeric" }) : "",
          status: STATUS_LABELS[comment.status] || "Waiting for review",
          excerpt: String(comment.body || "").slice(0, 200),
        })
        var del = item.querySelector("[data-reader-delete]")
        if (del) del.setAttribute("aria-label", "Delete your comment on " + String(comment.post_title || "this post"))
        list.appendChild(item)
      })
    }
  }

  function start() {
    document.querySelectorAll("form.comment-form[data-gl-comments]").forEach(enhanceForm)
    document.querySelectorAll("[data-gl-reader]").forEach(readerPage)
  }

  // For the tests (glComments.test.ts): the copies of the server's rules.
  window.__glComments = { runs: runs, avatarColor: avatarColor, reasons: REASONS, fieldReasons: FIELD_REASONS }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
