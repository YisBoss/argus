# 冻结契约（v1）— 任何人不要擅自改本文件里的字段名/路径

> 本文件是**唯一权威**的接口约定。后端、前端、文档、部署全部以它为准。
> 需要改动 → 先找 CodeBuddy（主 Agent）确认，改完同步更新本文件。

## 0. 项目定位

`Argus` —— 企微运维中枢：**企业微信自建应用**的服务端，提供三件事

1. **监控告警** —— 任意 HTTP 探针失败/恢复 → 推送到企微应用消息
2. **自定义菜单** —— 菜单按钮直达面板，做「查看状态 / 立即自检 / 重启服务 / 静音」等便捷操作
3. **Web 配置面板** —— 所有设置项都能在面板里改，无需改环境变量

设计原则：**通用**。不写死任何具体业务、任何部署方的域名/IP/端口/容器名。
一切通过面板配置。别人一条 `docker compose up -d` + 面板填参数即可用。

## 1. 文件所有权（一人一文件，禁止跨范围修改）

| 路径 | 归属 | 说明 |
|---|---|---|
| `docker-compose.yml` `.env.example` `.gitignore` `LICENSE` `app/settings.py` `.github/workflows/docker.yml` `docs/CONTRACT.md` | **主 Agent（已冻结）** | 只读，不要改 |
| `app/*.py` `app/api/*.py` `requirements.txt` | **开发** | 后端 |
| `app/static/*` | **前端** | 面板 UI |
| `Dockerfile` `.dockerignore` | **运维** | 镜像 + 部署验证 |
| `README.md` `README_EN.md` `docs/deploy.md` `docs/wecom-setup.md` | **内容** | 文档 |
| `docs/wecom-api-spec.md` | **调研** | 企微 API 实测笔记 |

**Git 操作全部由主 Agent 执行。** 其他人只往磁盘写文件，不要 `git add/commit/push`。

工作目录：`/workspace/argus/`

## 2. 运行时约定

- 容器内监听 **8080**（`uvicorn app.main:app --host 0.0.0.0 --port 8080`）
- 数据目录 `/data`（env `HUB_DATA_DIR`），SQLite 在 `/data/hub.db`
- 依赖只允许：`fastapi`、`uvicorn[standard]`、`httpx`、`pycryptodome`、`jinja2`（可选）
- Python 3.11+，**不要引入需要编译的重依赖**
- 前端**不要有 npm 构建步骤**：纯静态 HTML/CSS/JS，可直接被 FastAPI 挂载

## 3. 设置项（`app/settings.py` 已定义，键名固定）

见 `app/settings.py` 的 `DEFAULT_SETTINGS`。存储方式：SQLite 表 `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`，
启动时用 `DEFAULT_SETTINGS` 补齐缺失键。

敏感项（`SECRET_KEYS`）：`panel.admin_password`、`wecom.secret`、`wecom.callback_token`、`wecom.callback_aes_key`、`ingest.api_key`、`switch.am_token`、`switch.cb_token`。
`GET /api/settings` 返回时用 `settings.mask_settings()` 打码成 `********`；`PUT` 时若收到 `********` 表示「不修改」。

**内部键**（`settings.INTERNAL_SETTING_KEYS`）：存在 `settings` 表里但**不是**面板设置项，
`GET /api/settings` 必须剔除、`PUT /api/settings` 不接受。目前只有 `menu.local`
（菜单页保存的本地菜单 JSON，键名固定为 `menu.local`，值为 `{"button":[...]}` 的 JSON 字符串）。

**切换指令目标**（`switch.*`）：`switch.am_base` / `switch.am_token`（账号池）、
`switch.cb_base` / `switch.cb_token`（模型网关）、`switch.hermes_base`（Agent 模型切换接口）。
供企微菜单「切换」与文本指令（`@am` / `@cb` / `@hermes`）使用，实现见 `app/api/switcher.py`。
**全部留空即视为未配置**，对应指令回复「尚未配置」；代码里不写死任何部署方的地址/令牌。

## 4. 数据库表结构（固定）

```sql
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS targets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  headers TEXT NOT NULL DEFAULT '{}',       -- JSON 对象字符串
  body TEXT NOT NULL DEFAULT '',
  expect_status TEXT NOT NULL DEFAULT '200-299',  -- 支持 "200" 或 "200-299" 或 "200,301"
  timeout_s INTEGER NOT NULL DEFAULT 10,
  interval_s INTEGER NOT NULL DEFAULT 60,
  fail_threshold INTEGER NOT NULL DEFAULT 2,
  silence_minutes INTEGER NOT NULL DEFAULT 30,
  notify_recovery INTEGER NOT NULL DEFAULT 1,
  action_type TEXT NOT NULL DEFAULT 'none',  -- none | http
  action_method TEXT NOT NULL DEFAULT 'POST',
  action_url TEXT NOT NULL DEFAULT '',
  action_headers TEXT NOT NULL DEFAULT '{}',
  action_body TEXT NOT NULL DEFAULT '',
  action_confirm INTEGER NOT NULL DEFAULT 1,
  -- v1.1 新增：把该目标的动作暴露成企微菜单按钮（见 §7.1）
  menu_label TEXT NOT NULL DEFAULT '',      -- 空 = 不进菜单
  menu_order INTEGER NOT NULL DEFAULT 0,    -- 升序；相同则按 id
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS probe_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER NOT NULL, ts TEXT NOT NULL,
  ok INTEGER NOT NULL, status INTEGER, latency_ms INTEGER, error TEXT
);

CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id INTEGER, ts TEXT NOT NULL, kind TEXT NOT NULL,  -- fail | recovery | test | external
  message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, source TEXT NOT NULL, payload TEXT
);
```

## 5. HTTP API 契约

面板接口统一前缀 `/api`。鉴权：登录后下发 HttpOnly Cookie `woh_session`；未登录返回 `401 {"error":"unauthorized"}`。

> ⚠️ **前端禁止用 `document.cookie` 判断登录态**：`woh_session` 是 **HttpOnly**，JS 读不到。
> 必须**问服务端** —— 启动时调一个需要鉴权的接口（本项目用 `GET /api/status`），
> 401 即未登录；任何接口返回 401 时统一走 `onLogout()`。
> 2026-09-26 踩过这个坑：登录 POST 返回 200、Cookie 也正常下发，但前端读不到 Cookie
> → 立刻跳回登录页并清空密码框 → 用户看到的现象是「**输入密码没有任何反应**」。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 免鉴权，返回 `{"ok":true,"version":"..."}` |
| POST | `/api/login` | body `{"password":"..."}` → `{"ok":true}`，失败 401 |
| POST | `/api/logout` | 清 Cookie |
| GET | `/api/settings` | 返回全部设置（敏感项打码） |
| PUT | `/api/settings` | body 为部分设置对象，只更新传入的键；值为 `********` 则跳过 |
| POST | `/api/settings/test` | 用当前配置调 `gettoken`，返回 `{"ok":bool,"detail":"..."}` |
| GET | `/api/targets` | 目标列表 |
| POST | `/api/targets` | 新建，body 为 target 字段（不含 id） |
| PUT | `/api/targets/{id}` | 更新 |
| DELETE | `/api/targets/{id}` | 删除 |
| POST | `/api/targets/{id}/probe` | 立即探测一次，返回探测结果 |
| POST | `/api/targets/{id}/action` | 执行该目标绑定的动作（`action_type=http` 时） |
| GET | `/api/targets/{id}/history?limit=50` | 最近探测记录 |
| GET | `/api/alerts?limit=50` | 告警历史 |
| POST | `/api/notify/test` | 发一条测试消息到企微，返回 `{"ok":bool,"detail":"..."}` |
| GET | `/api/menu` | 返回 `{"remote":{...}|null,"local":{...},"error":"..."}`。`local` 优先返回面板保存过的（`menu.local`），否则是默认模板 |
| PUT | `/api/menu` | body `{"button":[...]}` 或 `{"preset":true}`；先本地校验（见 §7），不通过 → `400 {"detail":"..."}`；通过则存 `menu.local` 并推 `menu/create`；推送失败 → `502 {"detail":"..."}` |
| DELETE | `/api/menu` | 调 `menu/delete`；失败 → `502 {"detail":"..."}` |
| GET | `/api/status` | 概览：`{"targets_total":n,"targets_down":n,"last_alerts":[...],"silence_remaining_minutes":n}` |
| POST | `/api/silence` | body `{"minutes":N}`；**N=0 表示立即解除静音**。返回 `{"ok":true,"silence_remaining_minutes":n}` |
| POST | `/api/ingest` | **外部事件接入**（不走 Cookie，用 `X-Ingest-Key` 头鉴权）。详见 §5.1 |

### 5.1 外部事件接入 `POST /api/ingest`

**用途**：让**外部 watcher**（例如 NAS 上的 `am-watch.sh`）把告警统一汇入本服务，
复用去重 / 静音 / 告警历史 / 菜单查询，而不是各自直推企微。

**鉴权**：请求头 `X-Ingest-Key: <ingest.api_key>`。
`ingest.api_key` 为空时**该接口整体禁用**，一律返回 `403 {"error":"ingest disabled"}`；
鉴权失败返回 `401 {"error":"unauthorized"}`。
（**不要**用 Cookie 鉴权 —— 外部脚本拿不到 Cookie。）

**请求体**（JSON）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 来源标识，如 `am-watch`。写入 `events.source` |
| `kind` | 是 | `fail` \| `recovery` \| `info` |
| `message` | 是 | 人类可读文本，直接作为企微消息正文 |
| `dedup_key` | 否 | 去重键。同一 `dedup_key` 在 `notify.silence_minutes` 内**不重复推送** |

**行为**：

1. 一律写 `events` 表（`payload` = 原始请求体 JSON 字符串）
2. `kind=info` → 只写 `events`，**不推送、不写 alerts**
3. `kind=fail` / `recovery` → 写 `alerts`（`target_id=NULL`，`kind` 原样存 `fail`/`recovery`）
   - 处于**全局静音**期 → `delivered=0`，不推送
   - 否则推送企微，成功则 `delivered=1`
   - `dedup_key` 命中且在静音窗口内 → `delivered=0`，不推送

**响应**：`{"ok":true,"alert_id":<int|null>,"delivered":<bool>,"deduped":<bool>}`

**边界约定**：外部 watcher 的**自愈动作留在它自己那边**（它才有一键重启 / 换出口的权限），
本服务只负责**汇总与通知**，不反向控制外部系统。

### 企微回调（不鉴权，必须验签）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/wecom/callback` | URL 验证：校验 `msg_signature`，AES 解密 `echostr`，**返回明文 echostr** |
| POST | `/wecom/callback` | 接收消息/事件：验签 + 解密，**5 秒内返回 `success`**（明文即可） |

回调 URL 由用户在企微后台填成：`{panel.public_url}/wecom/callback`

## 6. 企微 API 用法

基址：`wecom.api_base`；若 `wecom.proxy_url` 非空，则**所有** qyapi 请求走该反代
（路径原样拼接，例如 `{proxy_url}/cgi-bin/gettoken?corpid=..&corpsecret=..`）。

- 取 token：`GET /cgi-bin/gettoken?corpid=&corpsecret=`（缓存，`expires_in` 提前 300s 刷新）
- 发消息：`POST /cgi-bin/message/send?access_token=` body `{"touser","toparty","msgtype":"text","agentid":<int>,"text":{"content":...}}`
  - `agentid` **必须是整数**，不能是字符串
- 菜单：`POST /cgi-bin/menu/create?access_token=&agentid=<int>` body `{"button":[...]}`
- 读菜单：`GET /cgi-bin/menu/get?access_token=&agentid=<int>`
- 删菜单：`GET /cgi-bin/menu/delete?access_token=&agentid=<int>`
- 回调加解密：AES-256-CBC，key = `base64decode(EncodingAESKey + "=")`；签名 `sha1(sorted(token, timestamp, nonce, encrypt)))`

## 7. 菜单默认模板

> ⚠️ **企微硬限制**：`button` 顶层数组**只能有 1~3 个**元素（实测错误码 40058
> `field 'button' expect array size in [1, 3]`）；每个父按钮最多 5 个子按钮。
> 所以不能把 5 个功能平铺在顶层 —— 必须用「父按钮 + sub_button」收拢。

`PUT /api/menu` 若传 `{"preset":true}` 则生成默认模板（**顶层 2~3 个**）。

**v1.1 起，`🔀 切换` 菜单由数据库里带 `menu_label` 的目标动态生成**（见 §7.1）；
没有任何这样的目标时，`🔀 切换` 整块不出现，退化成顶层 2 个：

```json
{"button":[
  {"type":"view","name":"📊 状态","url":"{public_url}/#/status"},
  {"name":"🔧 操作","sub_button":[
    {"type":"click","name":"🔕 静音1小时","key":"SILENCE_1H"},
    {"type":"click","name":"🔔 解除静音","key":"UNSILENCE"},
    {"type":"view","name":"🧪 自检","url":"{public_url}/#/selftest"},
    {"type":"view","name":"🚨 告警","url":"{public_url}/#/alerts"},
    {"type":"view","name":"⚙️ 设置","url":"{public_url}/#/settings"}
  ]}
]}
```

有 `menu_label` 目标时，插入顶层第 2 位（**最多取前 5 个**，按 `menu_order,id` 升序）：

```json
{"button":[
  {"type":"view","name":"📊 状态","url":"{public_url}/#/status"},
  {"name":"🔀 切换","sub_button":[
    {"type":"click","name":"<目标的 menu_label>","key":"ACT:<目标 id>"}
  ]},
  {"name":"🔧 操作","sub_button":[ "...同上一份，5 个..." ]}
]}
```

`public_url` 为空时不要生成 view 型按钮（会报错），退化成**顶层 1~2 个** click 按钮
（`SILENCE_1H` / `UNSILENCE`，以及最多 5 个 `ACT:` 按钮）。

### 7.1 菜单动作按钮 `ACT:<id>`

**用途**：让用户从企微菜单**一键触发**某个目标绑定的 HTTP 动作
（典型场景：切换上游账号池里的当前账号、切换某个本地服务的模型配置）。

**生成规则**：目标满足 `menu_label != ''` 且 `action_type == 'http'` 且 `action_url != ''`
→ 生成一个 `{"type":"click","name":"<menu_label>","key":"ACT:<id>"}`。
不满足条件的 `menu_label` 目标**跳过并记日志**，不要生成会点不动的按钮。

**`click` 事件处理**（在 `POST /wecom/callback` 里）：

1. `EventKey` 形如 `ACT:12` → 取 id=12 的目标
2. 目标不存在 / 不满足上述条件 → 回一条「该按钮已失效，请在面板里重新生成菜单」，**不要静默**
3. 处于**全局静音**期 → 仍然**执行动作**（静音只压告警通知，不挡用户主动操作），但回复里注明
4. 执行 `action_method` / `action_url` / `action_headers` / `action_body`，超时用 `timeout_s`
5. 回一条文本消息：`✅ <目标名> 已执行` + `HTTP <status>` + 响应体截断（≤200 字符）
   失败则 `❌ <目标名> 执行失败：<错误>`
6. 动作执行**不写 alerts 表**；写 `events` 表（`source='menu-action'`），便于排查

> ⚠️ **不做二次确认**：企微菜单 click 没有二次确认能力，所以 `menu_label` 的目标
> 应当是**幂等、可回退**的操作。破坏性操作（删除、重启生产）**不要**挂到菜单上。
> 面板里执行同一条动作时仍走 `action_confirm`。


`click` 事件在 `POST /wecom/callback` 里处理：

- `EventKey=SILENCE_1H` → 全局静音 60 分钟，回一条确认消息
- `EventKey=UNSILENCE` → **立即解除静音**（等价 `POST /api/silence {"minutes":0}`），回一条确认消息
- `EventKey=ACT:<id>` → 执行该目标的 HTTP 动作，回一条结果消息（见 §7.1）

> ⚠️ 必须有 `UNSILENCE`：否则用户从菜单点了静音之后就只能干等，是个死胡同。

**推送前必须本地校验**（否则只会拿到企微的 40058 报错，用户看不懂）：

- 顶层 `button` 数量 1~3
- 带 `sub_button` 的父按钮不能再带 `type`/`key`/`url`
- 每个 `sub_button` 数量 ≤ 5
- `view` 型必须有 `url`，`click` 型必须有 `key`
- **名称按字节数**：一级菜单 `name` ≤ 16 字节，二级菜单 ≤ 60 字节
  （中文 3 字节、emoji 4~6 字节 —— 不能按字符数算）

> **代理注意**：若 `wecom.proxy_url` 指向的是一个**路径白名单**式反代（只放行 gettoken /
> message/send / menu/create 等），则 `menu/get`、`menu/delete` 会 404。
> 这时「推送菜单」仍可用，但「读取远端菜单 / 删除菜单」不可用，面板要能优雅降级并提示用户。

## 8. 面板 UI 契约

单页应用，`index.html` + `app.js` + `style.css`，hash 路由：

- `#/status` 概览（默认页）
- `#/targets` 目标增删改 + 立即探测 + 执行动作 + 历史 + **菜单按钮设置（`menu_label` / `menu_order`）**
- `#/settings` 企微参数 + 通知策略 + 测试按钮 + 回调 URL 展示（带一键复制）
- `#/menu` 菜单编辑 + 一键生成默认菜单 + 推送/删除（**预览里要能看到 `ACT:` 动作按钮**）
- `#/selftest` 自检（企微连通性测试 + 发测试消息 + 一键探测全部目标）
- `#/alerts` 告警历史

要求：**中文界面**、响应式（手机企微里点开要能用）、不引入外部 CDN 依赖（离线可用）。

> ⚠️ **`menu_label` 的名称按 UTF-8 字节数校验**（二级 ≤ 60 字节），与 §7 的菜单校验同一套规则。
> 前端在输入框旁实时显示字节数，超了直接拦，不要等推送时才 400。

## 9. 验收标准（Definition of Done）

1. `docker compose up -d` 一条命令起服务，浏览器能打开面板并登录
2. 面板里填企微参数 → 点「测试」返回成功
3. 加一个 HTTP 探针目标 → 故意填错 URL → 收到企微告警；改回正确 → 收到恢复通知
4. 面板里一键生成菜单 → 企微里能看到菜单 → 点「状态」能打开面板
5. 面板里「重启服务」类动作可配置（HTTP 动作），点确认后真实执行
6. 回调 URL 验证通过（企微后台「保存」不报错）
7. README 里别人照着能跑起来，**不出现任何本项目私有信息**
