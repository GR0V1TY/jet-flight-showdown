# 苍穹飞行 · Jet Flight Showdown

同一句需求，三个大模型各写了一款 Three.js 喷气机飞行游戏。本仓库把它们并列部署成一个可直接游玩的网页游戏站。

打开首页 `index.html` 即为选择界面，点击任一卡片在当前页全屏运行游戏；鼠标移到屏幕左边缘的「返回」竖标签可退回选择界面。

## 三款作品

| # | 来源模型 | 作品 | 技术形态 | 目录 |
| --- | --- | --- | --- | --- |
| 01 | KIMI | AERION · 苍穹飞行 | Vite 单文件构建，Three.js 与样式全部内联进一页 HTML | `games/kimi/` |
| 02 | DS 4.1 Flash | SKYBREAKER · 喷气机飞行模拟 | 手写 UMD，单个 game.js，本地 three.js r128（CDN 仅兜底） | `games/ds/` |
| 03 | 6.1 Sol High | 掠境 · Jet Flight | 分模块 ES Modules，120 Hz 定步长物理，随包附验证报告 | `games/sol/` |

三款游戏的操作各不相同，进入后请以游戏内的按键提示为准，多数为 `W/A/S/D` 控制姿态、`Shift` 加/减油门。

## 目录结构

```
.
├── index.html              选择界面（本站首页）
├── favicon.ico
├── .nojekyll               关闭 Jekyll 处理，确保静态文件原样发布
└── games/
    ├── kimi/               AERION · 苍穹飞行
    │   └── index.html      单文件，内含全部 JS/CSS
    ├── ds/                 SKYBREAKER
    │   ├── index.html
    │   ├── game.js
    │   └── lib/three.min.js
    └── sol/                掠境 · Jet Flight
        ├── index.html
        ├── game.js         玩法 / 输入 / 计分
        ├── physics.js      飞行物理与航线
        ├── scene.js        场景与渲染
        ├── style.css
        ├── tokens.css
        ├── favicon.svg
        └── vendor/         本地 three.js 与许可证
```

## 本地运行

ES 模块不能通过 `file://` 打开，需要 HTTP 服务：

```bash
cd 仓库根目录
python -m http.server 8123
# 浏览器打开 http://127.0.0.1:8123/index.html
```

或任意静态服务器（`npx serve .`、`npx http-server .` 均可）。

## 部署

纯静态站点，宿主目录为仓库根目录，无构建步骤。GitHub Pages / Cloudflare Pages / Vercel / Netlify 均可直接托管。

### GitHub Pages

1. 仓库 Settings → Pages → Source 选择 `Deploy from a branch`，分支 `main`，目录 `/ (root)`。
2. 等待 Actions 中的 `pages build and deployment` 完成。
3. 访问 `https://<用户名>.github.io/<仓库名>/`。

> 若站点部署在子路径（如 `/repo-name/`），本仓库全部资源均使用相对路径，无需改动。

## 部署前的适配说明

- `games/sol/` 的模块文件由上游产物的 `.mjs` 改名为 `.js`，并同步修正了 `index.html`、`game.js`、`scene.js` 中的引用。原因是部分静态服务器（含 GitHub Pages）对 `.mjs` 返回 `text/plain`，导致 `<script type="module">` 因 MIME 校验失败而整页白屏。
- 三个目录下的游戏源码逻辑均未改动，仅做上述路径/扩展名适配与目录搬运。
- 根目录 `favicon.ico` 用于消除 `games/ds/` 页面隐式的 `/favicon.ico` 404。

## 验证记录

在本机以 `python -m http.server` 提供 HTTP 服务，用 Edge（无头，1440×900）通过 DevTools 协议逐页检查：

- 选择界面、三款游戏页面：0 控制台错误、0 未捕获异常；
- 三个游戏均成功创建 `1440×900` 的 WebGL 画布并渲染三维场景，HUD 数值随模拟推进；
- 选择界面 → iframe 内嵌三个游戏的进入/退回流程均可正常切换。

## 版权

三款游戏分别由对应模型生成，用作同题对比演示。`games/sol/vendor/THREE-LICENSE.txt` 与 `games/ds/lib/three.min.js` 相关 Three.js 采用 MIT 许可证。
