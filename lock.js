/* Simple password lock for the dashboard.
   Loaded synchronously in <head> on every page so nothing renders until unlocked.
   Note: this is client-side only — it keeps casual visitors out, but anyone
   who views the page source can read the password. Fine for a personal dashboard. */
(function () {
  var PASSWORD = "2000";
  var KEY = "dash_unlocked";
  var DEVICE_KEY = "dash_device_trusted";

  // Already unlocked this session, or this device is trusted? Do nothing.
  try {
    if (localStorage.getItem(DEVICE_KEY) === "yes") return;
    if (sessionStorage.getItem(KEY) === "yes") return;
  } catch (e) {}

  // Hide the page until the lock screen is up, to avoid a flash of content.
  var hide = document.createElement("style");
  hide.id = "lock-hide";
  hide.textContent = "html{visibility:hidden!important}";
  (document.head || document.documentElement).appendChild(hide);

  function buildLock() {
    var existing = document.getElementById("lock-hide");
    if (existing) existing.remove();

    var wrap = document.createElement("div");
    wrap.id = "lockscreen";
    wrap.innerHTML =
      '<style>' +
      '#lockscreen{position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'flex-direction:column;align-items:center;justify-content:center;' +
      'padding:24px;background:rgba(8,8,10,0.94);backdrop-filter:blur(24px) saturate(140%);' +
      '-webkit-backdrop-filter:blur(24px) saturate(140%);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;' +
      'color:#FAFAFA;user-select:none;-webkit-user-select:none}' +
      '#lock-lock{width:34px;height:34px;margin-bottom:18px;opacity:.9}' +
      '#lock-title{font-size:19px;font-weight:600;letter-spacing:.2px;margin-bottom:22px}' +
      '#lock-form{display:flex;gap:8px;width:100%;max-width:300px}' +
      '#lock-input{flex:1;min-width:0;padding:13px 15px;border-radius:12px;' +
      'border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.35);color:#FAFAFA;' +
      'font-family:inherit;font-size:16px;outline:none;transition:border-color .2s}' +
      '#lock-input::placeholder{color:rgba(255,255,255,.4)}' +
      '#lock-input:focus{border-color:rgba(255,255,255,.4)}' +
      '#lock-go{border:0;border-radius:12px;padding:13px 18px;cursor:pointer;' +
      'background:linear-gradient(180deg,#FFFFFF,#E8E5DD);color:#0A0A0B;' +
      'font-family:inherit;font-size:15px;font-weight:700;transition:filter .15s,transform .1s}' +
      '#lock-go:active{transform:translateY(1px)}' +
      '#lock-err{height:18px;margin-top:14px;font-size:13px;color:#FF6B6B;opacity:0;transition:opacity .2s}' +
      '@keyframes lockshake{10%,90%{transform:translateX(-4px)}30%,70%{transform:translateX(8px)}50%{transform:translateX(-8px)}}' +
      '.shake{animation:lockshake .4s}' +
      '</style>' +
      '<svg id="lock-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/>' +
      '<path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
      '<div id="lock-title">Enter Password</div>' +
      '<form id="lock-form" autocomplete="off">' +
      '<input id="lock-input" type="password" placeholder="Password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<button id="lock-go" type="submit">Go</button>' +
      '</form>' +
      '<div id="lock-err">Incorrect password</div>';
    document.body.appendChild(wrap);

    var form = wrap.querySelector("#lock-form");
    var input = wrap.querySelector("#lock-input");
    var errEl = wrap.querySelector("#lock-err");

    input.focus();

    function unlock() {
      try { sessionStorage.setItem(KEY, "yes"); localStorage.setItem(DEVICE_KEY, "yes"); } catch (e) {}
      wrap.style.transition = "opacity .25s";
      wrap.style.opacity = "0";
      setTimeout(function () { wrap.remove(); }, 260);
    }

    function wrong() {
      errEl.style.opacity = "1";
      form.classList.add("shake");
      setTimeout(function () { form.classList.remove("shake"); }, 450);
      input.value = "";
      input.focus();
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (input.value === PASSWORD) unlock();
      else wrong();
    });
    input.addEventListener("input", function () { errEl.style.opacity = "0"; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildLock);
  } else {
    buildLock();
  }
})();
