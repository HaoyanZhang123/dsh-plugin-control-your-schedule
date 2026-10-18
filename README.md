# dsh-plugin-control-your-schedule

> **纸屿**：把便签、纸页笔记、日历待办和画纸，装进 DSH 左侧栏。
> 一个纸面风格的轻量个人工作台。数据保存在本机，不联网。

版本 0.1.1 · DSH 0.2.1-rc.2 实测 · Windows 实测，macOS / Linux 通过构建与静态门禁

![首页](assets/screenshot-home.webp)

## 它是什么

在 DSH 的左侧栏点「便签」，主面板会展开一张纸面桌面：

- **便签**：随手写短句，自动保存；拖动便签顶部左侧的把手移动，正文区域不会误触。
- **纸页笔记**：长文写作，左侧列表搜索/切换，自动保存。
- **日历与待办**：按日期添加待办，完成勾选；右侧今日纸签同步摘要。
- **画纸**：手写/绘画，支持撤销、橡皮、导出 PNG。
- **底部应用坞**：所有应用的唯一入口；最右边的房子按钮一键收起所有窗口，再点一次恢复。
- **新手导览**：第一次打开自动播放 6 步导览；也可在「设置 → 快捷键 → 新手导览」重新播放。
- **数据备份**：设置 → 数据与备份，可导出/导入完整工作区 JSON。

## 安装

### 方式一：npm（发布后）

DSH → Plugins → Add plugin，填：

```
dsh-plugin-control-your-schedule
```

### 方式二：GitHub

DSH → Plugins → Add plugin，填：

```
https://github.com/HaoyanZhang123/dsh-plugin-control-your-schedule
```

### 方式三：本地开发

DSH → Plugins → Add plugin，填本目录的**绝对路径**：

```
<仓库路径>/dsh-plugin-control-your-schedule
```

> Add plugin 只接受绝对路径；相对路径会被拒绝。
> 已安装的插件不支持自动更新：升级 = 卸载后重装新版。

安装后在左侧栏「插件 / 自动化任务」下面出现「便签」。如果没出现，刷新页面；替换已安装的包需要重启 DSH。

## 数据存在哪里

- **DSH 数据目录（主存储）**：`$DSH_HOME/control-your-schedule/workspace.json`
  - Windows 默认：`C:\Users\<你>\.dsh\control-your-schedule\workspace.json`
  - 如果设置了 `DSH_HOME`，以该目录为准。
- **浏览器缓存（备用）**：IndexedDB / localStorage，用于页面快速启动。
- 导出/导入在「设置 → 数据与备份」中完成；换设备时导出 JSON，再导入即可。

## 兼容性

- 开发依据：DSH **0.2.1-rc.2**（2026-10）。
- 已验证：Windows 11 + DSH 0.2.1-rc.2（安装、侧栏、面板、刷新/切换后数据保持、宿主落盘、导入/导出路径）。
- 构建与静态门禁在 CI 的 Windows / macOS / Ubuntu 三个 runner 上跑（见 `.github/workflows/ci.yml`）。
- **未在 macOS / Linux 真机 DSH 上实测**：键盘标签会自动使用 ⌘/⌥；数据路径使用 `DSH_HOME` 或 `~/.dsh`；没有平台专属二进制。发现问题请提 issue。
- 页面本身是中文界面；插件列表的英文名称为 “Sticky”。

## 开发

```bash
# 构建 client.js（把 assets/paper-os.html 内嵌进客户端包）
python tools/build_page.py

# 校验产物是否与源码一致（CI 用）
python tools/build_page.py --check

# 项目门禁（页面契约 + 构建 + 宿主路由持久化）
python smoke/run_all_checks.py
```

目录：

| 路径 | 作用 |
|---|---|
| `index.js` | Host 半边：`/api/control-your-schedule/workspace` 读写 DSH 数据目录 |
| `src/client.src.js` | Client 半边：侧栏入口 + 主面板 + iframe 桥接 |
| `assets/paper-os.html` | 纸屿页面（唯一 UI 源） |
| `client.js` | 构建产物，禁止手改 |
| `tools/build_page.py` | 构建脚本 |
| `smoke/run_all_checks.py` | 项目门禁 |
| `smoke/host_route_test.mjs` | Host 持久化路由测试 |

### 设计取舍

- UI 不重写成 React：原页面用同源 iframe 隔离挂载，窗口拖拽、自动保存和键盘交互全部原样保留。
- 数据双写：页面先写浏览器存储保证即时可用，再通过 `postMessage` → Host 路由落盘到 DSH 数据目录；重开时以较新的快照启动。
- 没有第三方运行时依赖；Host 只用 Node 内置模块，构建只用 Python 标准库。

## License

MIT
