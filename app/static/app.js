/* Argus — 面板前端逻辑
 * 纯原生 JS，无依赖。Hash 路由，fetch 调 /api。
 * 契约见 docs/CONTRACT.md §5, §8。
 */
(function () {
  "use strict";

  // ===== 工具 =====
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k === "html") e.innerHTML = attrs[k];
        else if (k === "dataset") { for (var d in attrs.dataset) e.dataset[d] = attrs.dataset[d]; }
        else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") e.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  function toast(msg, isErr) {
    var t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (isErr ? " error" : "");
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; t.className = "toast"; }, 2600);
  }

  function fmtTime(s) {
    if (!s) return "—";
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    function pad(n) { return n < 10 ? "0" + n : n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast("已复制"); }, function () { fallbackCopy(text); });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制"); } catch (e) { toast("复制失败", true); }
    document.body.removeChild(ta);
  }

  // ===== HTTP 封装 =====
  var api = {
    get: function (path) { return req("GET", path); },
    post: function (path, body) { return req("POST", path, body); },
    put: function (path, body) { return req("PUT", path, body); },
    del: function (path) { return req("DELETE", path); }
  };
  function req(method, path, body) {
    var opts = { method: method, credentials: "same-origin", headers: {} };
    if (body != null) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      var ct = r.headers.get("content-type") || "";
      var p = ct.indexOf("json") >= 0 ? r.json() : r.text();
      return p.then(function (data) {
        if (!r.ok) throw { status: r.status, data: data };
        return data;
      });
    }).catch(function (err) {
      if (err && err.status === 401) { onLogout(); throw err; }
      var msg = (err && err.data && err.data.error) || (err && err.data && err.data.detail) || "请求失败";
      if (err && err.data && typeof err.data === "string") msg = err.data;
      toast(msg, true);
      throw err;
    });
  }

  // ===== 鉴权 =====
  // ⚠️ 不能用 document.cookie 判断登录态：woh_session 是 **HttpOnly**，JS 根本读不到。
  // 2026-09-26 踩过这个坑：登录 POST 明明 200、Cookie 也下发了，但前端读不到 Cookie
  // → 立刻跳回登录页并把密码框清空 → 用户看到的是「输入密码没有任何反应」。
  // 正确做法：**问服务端**（/api/status 需要鉴权，401 就说明没登录）。
  function checkLoggedIn() {
    return api.get("/api/status").then(
      function () { return true; },
      function () { return false; }
    );
  }

  function onLogout() {
    $("#topbar").hidden = true;
    $("#loginPage").classList.remove("hidden");
    $("#loginPassword").value = "";
    // 故意不清 location.hash：菜单里的「⚙️ 面板」是带 #/settings 的深链，
    // 清掉的话登录后就落到概览页，白点一次。
  }

  // 登录
  function initLogin() {
    var form = $("#loginForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var pwd = $("#loginPassword").value;
      var err = $("#loginError"); err.hidden = true;
      $("#loginBtn").disabled = true;
      api.post("/api/login", { password: pwd }).then(function () {
        enterApp();
      }).catch(function () {
        err.textContent = "密码错误";
        err.hidden = false;
      }).then(function () { $("#loginBtn").disabled = false; });
    });
  }

  function enterApp() {
    $("#loginPage").classList.add("hidden");
    $("#topbar").hidden = false;
    router();
  }

  // ===== 路由 =====
  var routes = {
    status: renderStatus,
    targets: renderTargets,
    settings: renderSettings,
    menu: renderMenu,
    selftest: renderSelftest,
    alerts: renderAlerts
  };

  function router() {
    // 这里不再做「登录态」判断：任何接口返回 401 时 req() 会自动 onLogout()，
    // 客户端自己猜登录态只会猜错（HttpOnly Cookie 读不到）。
    var hash = location.hash.replace(/^#\/?/, "");
    var route = hash || "status";
    if (!routes[route]) route = "status";
    $$(".nav-link").forEach(function (a) {
      a.classList.toggle("active", a.dataset.route === route);
    });
    $("#view").innerHTML = '<div class="loading">加载中</div>';
    try {
      routes[route]();
    } catch (e) {
      $("#view").textContent = "页面加载失败";
    }
  }

  window.addEventListener("hashchange", router);

  // 退出
  document.addEventListener("click", function (e) {
    if (e.target.closest("#btnLogout")) {
      api.post("/api/logout").then(onLogout);
    }
  });

  // ===== 概览页 =====
  function renderStatus() {
    var v = $("#view");
    Promise.all([api.get("/api/status"), api.get("/api/alerts?limit=5")]).then(function (res) {
      var s = res[0], alerts = res[1] || [];
      v.innerHTML = "";
      v.appendChild(el("div", { class: "stat-grid" }, [
        el("div", { class: "stat-card" }, [
          el("div", { class: "stat-num", text: String(s.targets_total || 0) }, []),
          el("div", { class: "stat-label", text: "目标总数" })
        ]),
        el("div", { class: "stat-card" }, [
          el("div", { class: "stat-num " + (s.targets_down > 0 ? "down" : "ok"), text: String(s.targets_down || 0) }),
          el("div", { class: "stat-label", text: "异常目标" })
        ]),
        el("div", { class: "stat-card" }, [
          el("div", { class: "stat-num", text: String(s.healthy || 0) }),
          el("div", { class: "stat-label", text: "正常目标" })
        ])
      ]));

      // 静音状态条（CONTRACT §5: /api/status 返回 silence_remaining_minutes）
      var mins = s.silence_remaining_minutes;
      var silenced = mins != null && mins > 0;
      v.appendChild(el("div", { class: "card silence-bar" + (silenced ? "" : " silence-bar-idle") }, [
        el("span", { class: "silence-icon", text: silenced ? "🔕" : "🔔" }),
        el("div", { class: "silence-text" }, [
          el("div", { class: "silence-title", text: silenced ? "全局静音中" : "告警正常推送" }),
          el("div", { class: "muted", text: silenced ? "告警暂不推送，剩余 " + mins + " 分钟" : "点击「静音 1 小时」暂停告警推送" })
        ]),
        el("div", { class: "silence-actions" }, [
          el("button", { class: "btn btn-sm" + (silenced ? " btn-ghost" : " btn-primary"), onclick: silence1h, disabled: silenced, text: "静音 1 小时" }),
          el("button", { class: "btn btn-sm", onclick: unsilence, disabled: !silenced, text: "解除静音" })
        ])
      ]));

      var card = el("div", { class: "card" }, [
        el("div", { class: "card-title", text: "最近告警" })
      ]);
      if (alerts.length === 0) {
        card.appendChild(emptyState("暂无告警"));
      } else {
        card.appendChild(el("div", { class: "table-wrap" }, [alertTable(alerts, false)]));
      }
      v.appendChild(card);
    });
  }

  function silence1h() {
    api.post("/api/silence", { minutes: 60 }).then(function (r) {
      toast("已开启静音 1 小时" + (r.silence_remaining_minutes != null ? "（剩余 " + r.silence_remaining_minutes + " 分钟）" : ""));
      renderStatus();
    }).catch(function () {});
  }

  function unsilence() {
    api.post("/api/silence", { minutes: 0 }).then(function (r) {
      toast("已解除静音" + (r.silence_remaining_minutes != null ? "（剩余 " + r.silence_remaining_minutes + " 分钟）" : ""));
      renderStatus();
    }).catch(function () {});
  }

  function alertTable(alerts, showTarget) {
    return el("table", { class: "data" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "时间" }), el("th", { text: "类型" }),
        el("th", { text: "来源" }),
        showTarget ? el("th", { text: "目标" }) : null,
        el("th", { text: "消息" }), el("th", { text: "送达" })
      ].filter(Boolean))]),
      el("tbody", {}, alerts.map(function (a) {
        return el("tr", {}, [
          el("td", { text: fmtTime(a.ts) }),
          el("td", {}, [alertKindTag(a.kind)]),
          el("td", {}, [alertSourceTag(a)]),
          showTarget ? el("td", { text: a.target_name || a.target_id || "—" }) : null,
          el("td", { text: a.message }),
          el("td", {}, [el("span", { class: "tag " + (a.delivered ? "tag-ok" : "tag-gray"), text: a.delivered ? "已送达" : "未送达" })])
        ].filter(Boolean));
      }))
    ]);
  }

  function alertKindTag(kind) {
    var map = {
      fail: ["tag-down", "故障"], recovery: ["tag-ok", "恢复"],
      test: ["tag-warn", "测试"], external: ["tag-gray", "外部"], info: ["tag-gray", "信息"]
    };
    var m = map[kind] || ["tag-gray", kind || "—"];
    return el("span", { class: "tag " + m[0], text: m[1] });
  }

  function alertSourceTag(a) {
    // 探针告警：有 target_id；外部接入：target_id 为 null
    if (a.target_id == null) {
      return el("span", { class: "tag tag-gray", text: "外部接入" });
    }
    return el("span", { class: "tag tag-ok", text: "探针" });
  }

  // ===== 目标页 =====
  function renderTargets() {
    var v = $("#view");
    v.innerHTML = "";
    v.appendChild(el("div", { class: "card" }, [
      el("div", { style: "display:flex;justify-content:space-between;align-items:center" }, [
        el("div", { class: "card-title", text: "探针目标" }),
        el("button", { class: "btn btn-primary btn-sm", onclick: function () { openTargetEditor(null); }, text: "+ 新建目标" })
      ]),
      el("div", { id: "targetsList", class: "table-wrap" }, [el("div", { class: "loading", text: "加载中" })])
    ]));
    loadTargets();
  }

  function loadTargets() {
    api.get("/api/targets").then(function (list) {
      var box = $("#targetsList");
      box.innerHTML = "";
      if (!list.length) { box.appendChild(emptyState("还没有探针目标，点「新建目标」添加一个吧")); return; }
      var tbl = el("table", { class: "data" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { text: "名称" }), el("th", { text: "URL" }),
          el("th", { text: "状态" }), el("th", { text: "间隔" }),
          el("th", { text: "动作" }), el("th", { class: "right", text: "操作" })
        ])]),
        el("tbody", {}, list.map(function (t) {
          var ok = t.last_ok;
          return el("tr", {}, [
            el("td", {}, [
              el("div", { text: t.name, style: "font-weight:500" }),
              el("div", { class: "muted", text: t.enabled ? "启用" : "已停用" })
            ]),
            el("td", {}, [
              el("div", { class: "mono", style: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", title: t.url, text: t.url })
            ]),
            el("td", {}, [
              ok === undefined || ok === null
                ? el("span", { class: "tag tag-gray", text: "未探测" })
                : (ok ? el("span", { class: "tag tag-ok", text: "正常" }) : el("span", { class: "tag tag-down", text: "异常" }))
            ]),
            el("td", { text: t.interval_s + "s" }),
            el("td", {}, [actionTag(t.action_type)]),
            el("td", {}, [el("div", { class: "row-actions" }, [
              el("button", { class: "btn btn-sm", onclick: function () { probeTarget(t.id); }, text: "探测" }),
              t.action_type && t.action_type !== "none"
                ? el("button", { class: "btn btn-sm", onclick: function () { doAction(t); }, text: t.action_confirm ? "执行动作" : "执行" })
                : null,
              el("button", { class: "btn btn-sm", onclick: function () { openTargetEditor(t); }, text: "编辑" }),
              el("button", { class: "btn btn-ghost btn-sm", onclick: function () { delTarget(t); }, text: "删除" }),
              el("button", { class: "btn btn-sm", onclick: function () { showHistory(t); }, text: "历史" })
            ].filter(Boolean))])
          ]);
        }))
      ]);
      box.appendChild(tbl);
    });
  }

  function actionTag(type) {
    if (!type || type === "none") return el("span", { class: "tag tag-gray", text: "无" });
    if (type === "http") return el("span", { class: "tag tag-warn", text: "HTTP" });
    return el("span", { class: "tag tag-gray", text: type });
  }

  function probeTarget(id) {
    toast("正在探测…");
    api.post("/api/targets/" + id + "/probe").then(function (r) {
      toast("探测结果：" + (r.ok ? "✅ 正常" : "❌ 异常") + (r.latency_ms ? " (" + r.latency_ms + "ms)" : ""));
      loadTargets();
    }).catch(function () {});
  }

  function doAction(t) {
    if (t.action_confirm) {
      showModal("确认执行", [
        el("p", { text: "即将对「" + t.name + "」执行动作：" }),
        el("p", { class: "mono", style: "background:var(--gray-1);padding:8px;border-radius:6px", text: (t.action_method || "POST") + " " + (t.action_url || "") }),
        el("p", { class: "muted", text: "此操作会真实发起 HTTP 请求，请确认。" })
      ], [
        el("button", { class: "btn", text: "取消", onclick: closeModal }),
        el("button", { class: "btn btn-danger", text: "确认执行", onclick: function () {
          closeModal();
          toast("正在执行…");
          api.post("/api/targets/" + t.id + "/action").then(function (r) {
            toast("动作已执行：" + (r.ok ? "✅ 成功" : "❌ 失败") + (r.detail ? " " + r.detail : ""));
          }).catch(function () {});
        } })
      ]);
    } else {
      api.post("/api/targets/" + t.id + "/action").then(function (r) {
        toast("动作已执行：" + (r.ok ? "✅" : "❌") + (r.detail ? " " + r.detail : ""));
      }).catch(function () {});
    }
  }

  function delTarget(t) {
    showModal("删除目标", [
      el("p", { text: "确定删除探针目标「" + t.name + "」？此操作不可撤销。" })
    ], [
      el("button", { class: "btn", text: "取消", onclick: closeModal }),
      el("button", { class: "btn btn-danger", text: "删除", onclick: function () {
        closeModal();
        api.del("/api/targets/" + t.id).then(function () { toast("已删除"); loadTargets(); }).catch(function () {});
      } })
    ]);
  }

  function showHistory(t) {
    api.get("/api/targets/" + t.id + "/history?limit=50").then(function (rows) {
      var body;
      if (!rows.length) {
        body = [emptyState("暂无记录")];
      } else {
        body = [el("div", { class: "table-wrap" }, [
          el("table", { class: "data" }, [
            el("thead", {}, [el("tr", {}, [
              el("th", { text: "时间" }), el("th", { text: "结果" }),
              el("th", { text: "状态码" }), el("th", { text: "延迟" }), el("th", { text: "错误" })
            ])]),
            el("tbody", {}, rows.map(function (r) {
              return el("tr", {}, [
                el("td", { text: fmtTime(r.ts) }),
                el("td", {}, [el("span", { class: "tag " + (r.ok ? "tag-ok" : "tag-down"), text: r.ok ? "正常" : "异常" })]),
                el("td", { text: r.status != null ? String(r.status) : "—" }),
                el("td", { text: r.latency_ms != null ? r.latency_ms + "ms" : "—" }),
                el("td", { class: "muted", text: r.error || "—" })
              ]);
            }))
          ])
        ])];
      }
      showModal("探测历史 — " + t.name, [el("p", { class: "muted", text: "最近 50 次探测记录" })].concat(body),
        [el("button", { class: "btn", text: "关闭", onclick: closeModal })]);
    }).catch(function () {});
  }

  // 目标编辑器
  function openTargetEditor(t) {
    var isNew = !t;
    var d = t || {};
    var f = {
      name: d.name || "", url: d.url || "", method: d.method || "GET",
      headers: d.headers || "{}", body: d.body || "",
      expect_status: d.expect_status || "200-299",
      timeout_s: d.timeout_s != null ? d.timeout_s : 10,
      interval_s: d.interval_s != null ? d.interval_s : 60,
      fail_threshold: d.fail_threshold != null ? d.fail_threshold : 2,
      silence_minutes: d.silence_minutes != null ? d.silence_minutes : 30,
      notify_recovery: d.notify_recovery != null ? d.notify_recovery : 1,
      enabled: d.enabled != null ? d.enabled : 1,
      action_type: d.action_type || "none",
      action_method: d.action_method || "POST",
      action_url: d.action_url || "",
      action_headers: d.action_headers || "{}",
      action_body: d.action_body || "",
      action_confirm: d.action_confirm != null ? d.action_confirm : 1
    };

    var body = el("div", {}, [
      el("div", { class: "section-title", text: "基本" }),
      input("name", "目标名称", f.name, true),
      input("url", "URL", f.url, true, "https://...", "url"),
      el("div", { class: "form-grid" }, [
        select("method", "方法", ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"], f.method),
        input("expect_status", "期望状态码", f.expect_status, false, "200-299 或 200,301"),
      ]),
      textarea("headers", "请求头 JSON", f.headers, "例：{\"Authorization\":\"Bearer xxx\"}"),
      textarea("body", "请求体", f.body, "POST/PUT 的 body"),

      el("div", { class: "section-title", text: "探测参数" }),
      el("div", { class: "form-grid" }, [
        num("timeout_s", "超时(秒)", f.timeout_s),
        num("interval_s", "间隔(秒)", f.interval_s),
      ]),
      el("div", { class: "form-grid" }, [
        num("fail_threshold", "失败阈值(次)", f.fail_threshold),
        num("silence_minutes", "静音(分钟)", f.silence_minutes),
      ]),
      el("div", { class: "form-grid" }, [
        checkbox("notify_recovery", "恢复时通知", f.notify_recovery),
        checkbox("enabled", "启用", f.enabled),
      ]),

      el("div", { class: "section-title", text: "动作 (可选)" }),
      el("div", { class: "form-grid" }, [
        select("action_type", "动作类型", ["none", "http"], f.action_type),
        select("action_method", "动作方法", ["POST", "GET", "PUT", "DELETE"], f.action_method),
      ]),
      input("action_url", "动作 URL", f.action_url, false, "https://..."),
      textarea("action_headers", "动作请求头 JSON", f.action_headers, "{}"),
      textarea("action_body", "动作请求体", f.action_body, ""),
      checkbox("action_confirm", "执行前确认", f.action_confirm),
    ]);

    showModal((isNew ? "新建" : "编辑") + "探针目标", [body], [
      el("button", { class: "btn", text: "取消", onclick: closeModal }),
      el("button", { class: "btn btn-primary", text: "保存", onclick: function () {
        var data = collectForm(body);
        // 类型转换
        ["timeout_s", "interval_s", "fail_threshold", "silence_minutes", "notify_recovery", "enabled", "action_confirm"].forEach(function (k) {
          data[k] = parseInt(data[k], 10) || 0;
        });
        ["notify_recovery", "enabled", "action_confirm"].forEach(function (k) {
          data[k] = data[k] ? 1 : 0;
        });
        try {
          JSON.parse(data.headers || "{}");
          JSON.parse(data.action_headers || "{}");
        } catch (e) {
          toast("请求头不是合法 JSON", true); return;
        }
        var p = isNew ? api.post("/api/targets", data) : api.put("/api/targets/" + t.id, data);
        p.then(function () {
          closeModal();
          toast("已保存");
          loadTargets();
        }).catch(function () {});
      } })
    ]);

    function input(name, label, val, req, ph, type) {
      return el("div", { class: "form-group" }, [
        el("label", { class: "form-label", html: escapeHtml(label) + (req ? '<span class="req">*</span>' : '') }),
        el("input", { class: "form-input", name: name, value: val != null ? val : "", placeholder: ph || "", type: type || "text" })
      ]);
    }
    function num(name, label, val) {
      return el("div", { class: "form-group" }, [
        el("label", { class: "form-label", text: label }),
        el("input", { class: "form-input", name: name, value: val != null ? val : "", type: "number" })
      ]);
    }
    function select(name, label, opts, val) {
      return el("div", { class: "form-group" }, [
        el("label", { class: "form-label", text: label }),
        el("select", { class: "form-select", name: name }, opts.map(function (o) {
          return el("option", { value: o, text: o, selected: o === val });
        }))
      ]);
    }
    function textarea(name, label, val, ph) {
      return el("div", { class: "form-group" }, [
        el("label", { class: "form-label", text: label }),
        el("textarea", { class: "form-textarea", name: name, placeholder: ph || "" }, [val || ""])
      ]);
    }
    function checkbox(name, label, val) {
      return el("div", { class: "form-group" }, [
        el("label", { style: "display:flex;align-items:center;gap:6px;cursor:pointer" }, [
          el("input", { type: "checkbox", name: name, checked: !!val }),
          el("span", { text: label })
        ])
      ]);
    }
  }

  function collectForm(root) {
    var data = {};
    $$("input, select, textarea", root).forEach(function (i) {
      if (!i.name) return;
      if (i.type === "checkbox") data[i.name] = i.checked ? 1 : 0;
      else data[i.name] = i.value;
    });
    return data;
  }

  // ===== 设置页 =====
  function renderSettings() {
    var v = $("#view");
    v.innerHTML = '<div class="loading">加载中</div>';
    api.get("/api/settings").then(function (s) {
      v.innerHTML = "";
      var card = el("div", { class: "card" }, [
        el("div", { class: "card-title", text: "面板设置" })
      ]);
      card.appendChild(settingsSection("面板", [
        pwdField("panel.admin_password", "管理密码", s["panel.admin_password"], true),
        textField("panel.public_url", "公网基址", s["panel.public_url"], "https://your-domain.example.com:8080"),
      ], "改面板登录密码、设置面板公网地址（用于拼回调 URL 和菜单链接）。"));
      card.appendChild(settingsSection("企业微信应用", [
        textField("wecom.corp_id", "企业 ID", s["wecom.corp_id"], "ww1234567890abcdef"),
        textField("wecom.agent_id", "应用 AgentId", s["wecom.agent_id"], "1000002"),
        pwdField("wecom.secret", "应用 Secret", s["wecom.secret"], true),
      ], "在企微后台「应用管理 → 自建应用」里获取。"));
      card.appendChild(settingsSection("接收消息回调", [
        textField("wecom.callback_token", "回调 Token", s["wecom.callback_token"], "在企微后台「接收消息」设置里生成"),
        pwdField("wecom.callback_aes_key", "回调 EncodingAESKey", s["wecom.callback_aes_key"], true),
      ], "用于验证企微回调请求。填好后把下面的回调 URL 配到企微后台。"));
      card.appendChild(settingsSection("企微 API", [
        textField("wecom.api_base", "API 基址", s["wecom.api_base"], "https://qyapi.weixin.qq.com"),
        textField("wecom.proxy_url", "API 反代 (可选)", s["wecom.proxy_url"], "https://wx-proxy.example.com"),
      ], "若本机出口 IP 不在企微可信 IP 白名单，可填一个反代地址。"));
      card.appendChild(settingsSection("接收人", [
        textField("wecom.touser", "接收人 UserID", s["wecom.touser"], "企微 userid，多个用逗号分隔；@all 表示应用可见范围内全部"),
        textField("wecom.toparty", "接收部门", s["wecom.toparty"], "部门 ID，多个用逗号"),
      ], "告警消息发到这里。@all 表示应用可见范围内全部人。"));
      card.appendChild(settingsSection("通知策略", [
        boolField("notify.enabled", "启用通知", s["notify.enabled"]),
        numField("notify.fail_threshold", "失败阈值(次)", s["notify.fail_threshold"]),
        numField("notify.silence_minutes", "静音(分钟)", s["notify.silence_minutes"]),
        boolField("notify.recovery", "恢复时通知", s["notify.recovery"]),
      ], "连续失败多少次才告警、同一问题多久内不重复推。"));
      card.appendChild(settingsSection("监控引擎", [
        numField("monitor.tick_seconds", "调度心跳(秒)", s["monitor.tick_seconds"]),
        numField("log.retain_days", "日志保留(天)", s["log.retain_days"]),
      ], "调度器多久跑一轮、探测结果保留多久。"));
      card.appendChild(settingsSection("切换指令", [
        textField("switch.am_base", "账号池基址", s["switch.am_base"], "http://10.0.0.2:8045"),
        pwdField("switch.am_token", "账号池令牌", s["switch.am_token"], true),
        textField("switch.cb_base", "模型网关基址", s["switch.cb_base"], "http://10.0.0.2:8666"),
        pwdField("switch.cb_token", "模型网关令牌", s["switch.cb_token"], true),
        textField("switch.hermes_base", "Agent 切换接口基址", s["switch.hermes_base"], "http://10.0.0.2:8620"),
      ], "企微菜单「切换」与文本指令（@am / @cb / @hermes）用；全部本地转发，0 Token。留空则该指令回复「尚未配置」。"));
      card.appendChild(settingsSection("外部事件接入", [
        pwdField("ingest.api_key", "接入密钥 (Ingest Key)", s["ingest.api_key"], true),
      ], "外部脚本（如 NAS 上的 watcher）通过 POST /api/ingest 汇入告警，复用去重/静音/通知。留空则禁用该接口。"));

      // 回调 URL 展示
      var pub = s["panel.public_url"] || "";
      var cbUrl = pub ? pub.replace(/\/$/, "") + "/wecom/callback" : "(请先填公网基址)";
      card.appendChild(el("div", { class: "section-title", text: "回调 URL" }));
      card.appendChild(el("p", { class: "muted", text: "把这个 URL 填到企微后台「接收消息」的 URL 栏里：" }));
      card.appendChild(el("div", { class: "copy-box" }, [
        el("input", { class: "form-input", readonly: true, value: cbUrl, id: "callbackUrl" }),
        el("button", { class: "btn", text: "复制", onclick: function () { copyText(cbUrl); } })
      ]));

      // Ingest URL 展示
      var ingestUrl = pub ? pub.replace(/\/$/, "") + "/api/ingest" : "(请先填公网基址)";
      card.appendChild(el("div", { class: "section-title", text: "外部接入 URL" }));
      card.appendChild(el("p", { class: "muted", text: "外部脚本 POST 到这个地址，请求头带 X-Ingest-Key: <接入密钥>：" }));
      card.appendChild(el("div", { class: "copy-box" }, [
        el("input", { class: "form-input", readonly: true, value: ingestUrl, id: "ingestUrl" }),
        el("button", { class: "btn", text: "复制", onclick: function () { copyText(ingestUrl); } })
      ]));

      // 测试按钮区
      card.appendChild(el("div", { class: "section-title", text: "测试" }));
      card.appendChild(el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
        el("button", { class: "btn btn-primary", text: "测试企微凭据", onclick: testSettings }),
        el("button", { class: "btn", text: "发送测试消息", onclick: testNotify })
      ]));

      card.appendChild(el("div", { style: "margin-top:20px;display:flex;gap:8px" }, [
        el("button", { class: "btn btn-primary", text: "保存设置", onclick: function () { saveSettings(card); } })
      ]));
      v.appendChild(card);
    }).catch(function () {});
  }

  function settingsSection(title, fields, hint) {
    var w = el("details", { class: "collapsible" }, [
      el("summary", { text: title })
    ]);
    var inner = el("div", {}, fields);
    if (hint) inner.appendChild(el("p", { class: "muted", style: "margin-bottom:10px", text: hint }));
    w.appendChild(inner);
    return w;
  }

  function textField(name, label, val, ph) {
    return el("div", { class: "form-group" }, [
      el("label", { class: "form-label", text: label }),
      el("input", { class: "form-input", "data-key": name, value: val || "", placeholder: ph || "" })
    ]);
  }
  function pwdField(name, label, val, secret) {
    return el("div", { class: "form-group" }, [
      el("label", { class: "form-label", text: label }),
      el("input", { class: "form-input", type: "password", "data-key": name, value: val || "", placeholder: secret ? "(已设置，留空不修改)" : "" })
    ]);
  }
  function numField(name, label, val) {
    return el("div", { class: "form-group" }, [
      el("label", { class: "form-label", text: label }),
      el("input", { class: "form-input", type: "number", "data-key": name, value: val || "" })
    ]);
  }
  function boolField(name, label, val) {
    var b = val === "true" || val === "1" || val === true;
    return el("div", { class: "form-group" }, [
      el("label", { style: "display:flex;align-items:center;gap:6px;cursor:pointer" }, [
        el("input", { type: "checkbox", "data-key": name, "data-type": "bool", checked: b }),
        el("span", { text: label })
      ])
    ]);
  }

  function saveSettings(root) {
    var data = {};
    $$("[data-key]", root).forEach(function (i) {
      var k = i.dataset.key;
      var v = i.dataset.type === "bool" ? (i.checked ? "true" : "false") : i.value;
      // 空密码框 = 不修改
      if (i.type === "password" && !v) return;
      data[k] = v;
    });
    api.put("/api/settings", data).then(function () {
      toast("设置已保存");
      renderSettings();
    }).catch(function () {});
  }

  function testSettings() {
    toast("正在测试凭据…");
    api.post("/api/settings/test").then(function (r) {
      toast(r.ok ? "✅ 凭据有效" : "❌ " + (r.detail || "失败"), !r.ok);
    }).catch(function () {});
  }
  function testNotify() {
    toast("正在发送测试消息…");
    api.post("/api/notify/test").then(function (r) {
      toast(r.ok ? "✅ 已发送测试消息" : "❌ " + (r.detail || "发送失败"), !r.ok);
    }).catch(function () {});
  }

  // ===== 菜单页 =====
  function renderMenu() {
    var v = $("#view");
    v.innerHTML = '<div class="loading">加载中</div>';
    api.get("/api/menu").then(function (r) {
      v.innerHTML = "";
      var card = el("div", { class: "card" }, [
        el("div", { class: "card-title", text: "企微自定义菜单" })
      ]);

      if (r.error) {
        card.appendChild(el("p", { class: "muted", text: "获取远程菜单出错：" + r.error }));
      }

      // 远程菜单
      card.appendChild(el("div", { class: "section-title", text: "远程菜单 (企微端)" }));
      if (r.remote && r.remote.button) {
        card.appendChild(menuPreview(r.remote));
      } else {
        card.appendChild(el("p", { class: "muted", text: "企微端还没有菜单" }));
      }

      // 本地编辑
      card.appendChild(el("div", { class: "section-title", text: "本地菜单 JSON" }));
      var ta = el("textarea", { class: "form-textarea", id: "menuJson", style: "min-height:200px", text: JSON.stringify(r.local || { button: [] }, null, 2) });
      card.appendChild(ta);

      card.appendChild(el("div", { style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap" }, [
        el("button", { class: "btn btn-primary", text: "保存并推送", onclick: function () { pushMenu(false); } }),
        el("button", { class: "btn", text: "一键生成默认菜单", onclick: function () { pushMenu(true); } }),
        el("button", { class: "btn btn-danger", text: "删除菜单", onclick: delMenu }),
      ]));

      card.appendChild(el("p", { class: "muted", style: "margin-top:12px", text: "「一键生成默认菜单」会按 CONTRACT §7 模板生成菜单并推送。若公网基址未设置则只生成 click 型按钮。" }));

      v.appendChild(card);
    }).catch(function () {});
  }

  function menuPreview(menu) {
    var wrap = el("div", { class: "table-wrap" });
    var btns = menu.button || [];
    if (!btns.length) { wrap.appendChild(emptyState("空菜单")); return wrap; }
    var rows = [];
    btns.forEach(function (b) {
      rows.push(menuRow(b, false));
      (b.sub_button || []).forEach(function (s) { rows.push(menuRow(s, true)); });
    });
    wrap.appendChild(el("table", { class: "data" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "名称" }), el("th", { text: "类型" }), el("th", { text: "URL / Key" })
      ])]),
      el("tbody", {}, rows)
    ]));
    return wrap;
  }

  function menuRow(b, isSub) {
    var name = el("span", { text: (isSub ? "└ " : "") + (b.name || "—") });
    if (isSub) name.style.paddingLeft = "14px";
    var type = b.type || (b.sub_button ? "分组" : "—");
    return el("tr", {}, [
      el("td", {}, [name]),
      el("td", {}, [el("span", { class: "tag tag-gray", text: type })]),
      el("td", { class: "mono", text: b.url || b.key || "—" })
    ]);
  }

  function pushMenu(preset) {
    var body = preset ? { preset: true } : (function () {
      var ta = $("#menuJson");
      try { return JSON.parse(ta.value); }
      catch (e) { toast("JSON 格式错误", true); return null; }
    })();
    if (!body) return;
    toast("正在推送菜单…");
    api.put("/api/menu", body).then(function (r) {
      toast(r.ok ? "✅ 菜单已推送" : "❌ " + (r.detail || r.error || "推送失败"), !r.ok);
      renderMenu();
    }).catch(function () {});
  }

  function delMenu() {
    showModal("删除菜单", [
      el("p", { text: "确定删除企微端的菜单？删除后企微应用里将看不到菜单。" })
    ], [
      el("button", { class: "btn", text: "取消", onclick: closeModal }),
      el("button", { class: "btn btn-danger", text: "删除", onclick: function () {
        closeModal();
        toast("正在删除…");
        api.del("/api/menu").then(function (r) {
          toast(r.ok ? "✅ 菜单已删除" : "❌ " + (r.detail || r.error || "删除失败"), !r.ok);
          renderMenu();
        }).catch(function () {});
      } })
    ]);
  }

  // ===== 自检页 =====
  function renderSelftest() {
    var v = $("#view");
    v.innerHTML = "";

    var log = el("div", { class: "mono", style: "white-space:pre-wrap;margin-top:14px;font-size:13px;line-height:1.7" });
    function say(line) { log.textContent += line + "\n"; }

    function runStep(label, path) {
      say("… " + label);
      api.post(path).then(function (r) {
        say((r.ok ? "✅ " : "❌ ") + label + "：" + (r.detail || (r.ok ? "OK" : "失败")));
      }).catch(function () { say("❌ " + label + "：请求失败"); });
    }

    function probeAll() {
      say("… 拉取目标列表");
      api.get("/api/targets").then(function (list) {
        if (!list || !list.length) { say("（还没有配置任何目标）"); return; }
        say("共 " + list.length + " 个目标，逐个探测：");
        list.forEach(function (t) {
          api.post("/api/targets/" + t.id + "/probe").then(function (r) {
            say((r.ok ? "✅ " : "❌ ") + (t.name || t.id) +
              "  " + (r.status != null ? r.status : "-") +
              (r.latency_ms != null ? "  " + r.latency_ms + "ms" : "") +
              (r.error ? "  " + r.error : ""));
          }).catch(function () { say("❌ " + (t.name || t.id) + "：请求失败"); });
        });
      }).catch(function () { say("❌ 拉取目标列表失败"); });
    }

    var card = el("div", { class: "card" }, [
      el("div", { class: "card-title", text: "自检" }),
      el("p", { class: "muted", text: "按顺序检查企微凭据 → 消息通道 → 所有监控目标。企微菜单里的「🧪 自检」就是跳到这一页。" }),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
        el("button", { class: "btn btn-primary", text: "① 测试企微连接", onclick: function () { runStep("企微连接", "/api/settings/test"); } }),
        el("button", { class: "btn", text: "② 发测试消息", onclick: function () { runStep("测试消息", "/api/notify/test"); } }),
        el("button", { class: "btn", text: "③ 探测全部目标", onclick: probeAll }),
        el("button", { class: "btn", text: "清空输出", onclick: function () { log.textContent = ""; } }),
      ]),
      log
    ]);
    v.appendChild(card);
  }

  // ===== 告警页 =====
  function renderAlerts() {
    var v = $("#view");
    v.innerHTML = '<div class="loading">加载中</div>';
    api.get("/api/alerts?limit=50").then(function (list) {
      v.innerHTML = "";
      var card = el("div", { class: "card" }, [
        el("div", { class: "card-title", text: "告警历史" })
      ]);
      if (!list || !list.length) {
        card.appendChild(emptyState("暂无告警记录"));
      } else {
        card.appendChild(el("div", { class: "table-wrap" }, [alertTable(list, true)]));
      }
      v.appendChild(card);
    }).catch(function () {});
  }

  // ===== 公共组件 =====
  function emptyState(text) {
    return el("div", { class: "empty" }, [
      el("div", { class: "empty-icon", text: "📭" }),
      el("div", { text: text })
    ]);
  }

  function showModal(title, bodyChildren, footerChildren) {
    closeModal();
    var mask = el("div", { class: "modal-mask", id: "modalMask" }, [
      el("div", { class: "modal" }, [
        el("div", { class: "modal-title", text: title }),
        el("div", {}, bodyChildren),
        el("div", { class: "modal-footer" }, footerChildren || [])
      ])
    ]);
    mask.addEventListener("click", function (e) { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);
  }
  function closeModal() {
    var m = $("#modalMask"); if (m) m.remove();
  }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  // ===== 启动 =====
  function boot() {
    initLogin();
    checkLoggedIn().then(function (ok) {
      if (ok) { enterApp(); }
      else { $("#loginPage").classList.remove("hidden"); }
    });
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
