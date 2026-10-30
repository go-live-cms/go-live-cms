/*
 * Default theme: Light / Dark / System switch and the phone menu (#345).
 *
 * Loaded from <head> as a plain, render-blocking <script src> (base.astro), so the
 * reader's theme is on <html> before the first paint (no flash of the wrong theme) and
 * it works under a CSP of script-src 'self': there is no inline script to allow.
 *
 * The choice is stored under the key in the script tag's data-storage-key. "system"
 * (the default) follows prefers-color-scheme and keeps following it while the page is
 * open. Without JavaScript the CSS falls back to prefers-color-scheme on its own.
 */
;(function () {
  var root = document.documentElement
  var script = document.currentScript
  var storageKey = (script && script.getAttribute("data-storage-key")) || "gl-theme-preference"
  var CHOICES = ["light", "dark", "system"]
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null

  function stored() {
    try {
      var value = window.localStorage.getItem(storageKey)
      return CHOICES.indexOf(value) >= 0 ? value : "system"
    } catch (e) {
      return "system"
    }
  }

  function store(choice) {
    try {
      window.localStorage.setItem(storageKey, choice)
    } catch (e) {
      // Storage blocked: the choice still applies to this page.
    }
  }

  var preference = stored()

  function apply() {
    var resolved = preference === "system" ? (media && media.matches ? "dark" : "light") : preference
    root.setAttribute("data-theme", resolved)
    root.setAttribute("data-theme-preference", preference)
    var buttons = document.querySelectorAll("[data-theme-choice]")
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute("data-theme-choice") === preference
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false")
    }
  }

  root.setAttribute("data-js", "")
  apply()

  if (media) {
    var onSystemChange = function () {
      if (preference === "system") apply()
    }
    if (media.addEventListener) media.addEventListener("change", onSystemChange)
    else if (media.addListener) media.addListener(onSystemChange)
  }

  function setupThemeMenu() {
    var toggle = document.querySelector("[data-theme-menu-toggle]")
    var menu = toggle && document.getElementById(toggle.getAttribute("aria-controls"))
    if (!toggle || !menu) return

    function setOpen(open) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false")
      menu.hidden = !open
    }
    toggle.addEventListener("click", function () {
      setOpen(menu.hidden)
    })
    document.addEventListener("click", function (event) {
      if (!menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false)
    })
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !menu.hidden) {
        setOpen(false)
        toggle.focus()
      }
    })
    menu.addEventListener("click", function (event) {
      if (event.target.closest("[data-theme-choice]")) {
        setOpen(false)
        toggle.focus()
      }
    })
  }

  // The header menu's children (#347): each disclosure button opens its list; Escape
  // or a click elsewhere closes it, and opening one closes the others.
  function setupNavSubmenus() {
    var groups = document.querySelectorAll("[data-nav-group]")
    if (!groups.length) return

    function setOpen(group, open) {
      var toggle = group.querySelector("[data-nav-sub-toggle]")
      if (open) group.setAttribute("data-open", "")
      else group.removeAttribute("data-open")
      if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false")
    }
    function closeAll(except) {
      for (var i = 0; i < groups.length; i++) if (groups[i] !== except) setOpen(groups[i], false)
    }
    for (var i = 0; i < groups.length; i++) {
      var toggle = groups[i].querySelector("[data-nav-sub-toggle]")
      if (!toggle) continue
      toggle.addEventListener("click", function (event) {
        var group = event.currentTarget.closest("[data-nav-group]")
        var open = !group.hasAttribute("data-open")
        closeAll(group)
        setOpen(group, open)
      })
    }
    document.addEventListener("click", function (event) {
      if (!event.target.closest || !event.target.closest("[data-nav-group]")) closeAll(null)
    })
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return
      var open = document.querySelector("[data-nav-group][data-open]")
      if (!open) return
      setOpen(open, false)
      var toggle = open.querySelector("[data-nav-sub-toggle]")
      if (toggle) toggle.focus()
    })
    // Tabbing out of a group closes it.
    for (var j = 0; j < groups.length; j++) {
      groups[j].addEventListener("focusout", function (event) {
        var group = event.currentTarget
        if (!event.relatedTarget || !group.contains(event.relatedTarget)) setOpen(group, false)
      })
    }
  }

  function setupPhoneMenu() {
    var dialog = document.querySelector("[data-site-menu]")
    if (!dialog || typeof dialog.showModal !== "function") return
    var openers = document.querySelectorAll("[data-site-menu-open]")
    for (var i = 0; i < openers.length; i++) {
      openers[i].addEventListener("click", function (event) {
        dialog.showModal()
        event.currentTarget.setAttribute("aria-expanded", "true")
      })
    }
    dialog.addEventListener("close", function () {
      for (var j = 0; j < openers.length; j++) openers[j].setAttribute("aria-expanded", "false")
    })
    var closers = dialog.querySelectorAll("[data-site-menu-close]")
    for (var k = 0; k < closers.length; k++) {
      closers[k].addEventListener("click", function () {
        dialog.close()
      })
    }
    // The menu is for phones: close it if the window grows past the breakpoint.
    if (window.matchMedia) {
      var wide = window.matchMedia("(min-width: 761px)")
      var onWide = function () {
        if (wide.matches && dialog.open) dialog.close()
      }
      if (wide.addEventListener) wide.addEventListener("change", onWide)
    }
  }

  function setup() {
    apply()
    document.addEventListener("click", function (event) {
      var button = event.target.closest && event.target.closest("[data-theme-choice]")
      if (!button) return
      preference = button.getAttribute("data-theme-choice")
      store(preference)
      apply()
    })
    setupThemeMenu()
    setupNavSubmenus()
    setupPhoneMenu()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup)
  else setup()
})()
