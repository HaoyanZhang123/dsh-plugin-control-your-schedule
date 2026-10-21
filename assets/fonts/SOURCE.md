# 内置手写体：霞鹜文楷子集（lxgw-wenkai-hand.woff2）

本目录存放便签正文使用的内置手写体。**这是上游字体的一个子集**，不是完整字体：
覆盖 ASCII、GB2312 符号/标点、GB2312 一级（3755）+ 二级（3008）汉字与少量 UI 符号；
**子集之外的字会回退到系统字体**（CSS 的 `font-family` 里排在本字体之后的那些），
所以缺字不会显示成方框，只是字形风格回退。

## 上游

| 项 | 值 |
|---|---|
| 字体 | 霞鹜文楷 LXGW WenKai（Regular） |
| 仓库 | https://github.com/lxgw/LxgwWenKai |
| 版本 | v1.530（tag `v1.530`，commit `4becfb4d5cf0c92cfdb60a6e9b504bda43315325`） |
| 源文件直链 | https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf |
| 源文件大小 / SHA-256 | 25 928 940 字节 / `2d73eea94ad808999d90c0000c239a84a33b09d4bc6ab6c5b8bbf1eda8a7fc8b` |
| 许可证 | SIL Open Font License 1.1（见同目录 `LICENSE-lxgw-wenkai.txt`） |
| 上游版权 | Copyright 2021-2026 LXGW；Copyright 2020 The Klee Project Authors |

许可证里的附加许可（ADDITIONAL PERMISSION）明确允许：为 Web 字体分发而**子集化或转换为
WOFF/WOFF2** 的修改版本可以继续使用保留字体名（霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW），
前提是**不作为可安装的桌面字体**二次分发。本仓库只把它当 Web 字体随插件分发，符合该条件。

## 产物

| 项 | 值 |
|---|---|
| 文件 | `lxgw-wenkai-hand.woff2` |
| 字节数 | 1 625 084（约 1.55 MiB） |
| SHA-256 | `56731348ac9209bc0b1995a15759b73f8fe9331d20f821b59b11bae7724e0c1c` |
| 字形数 | 7958 |
| cmap 码位数 | 7552 |
| 覆盖 | ASCII 95 + GB2312 符号 682 + 一级汉字 3755 + 二级汉字 3008 + UI 符号 10 = **7549 个请求码位全部命中**（`…` 同时出现在符号区和 UI 符号里，去重后 7549）；cmap 里另有 3 个（`∋ ∼ ≅`）是 GSUB 闭环带进来的连字部件，无副作用 |

子集参数：WOFF2、`--no-hinting`（去掉 TrueType 指令）、`--notdef-outline`、保留 name 表全部记录、
关闭时间戳重算（同机重跑逐字节一致）。

## 再生成

开发期依赖（**不是插件的运行期依赖**，装完即可删环境）：

```bash
python -m pip install fonttools brotli
```

取得上游源（任选其一，需与本文件记录的 SHA-256 一致）：

```bash
curl -L -o LXGWWenKai-Regular.ttf \
  https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf
```

构建（脚本里没有绝对路径，路径都相对脚本自身或 `--source`）：

```bash
# 在 plugin/ 目录下
python tools/subset_font.py                         # 自动找 output/_probe/fontwork/ 下的上游 ttf
python tools/subset_font.py --source ../LXGWWenKai-Regular.ttf
python tools/subset_font.py --check                 # 只校验已提交产物是否过期（不改文件）
```

脚本会打印：输入路径、输入 SHA-256、输出路径、字节数、各组码位数、cmap 覆盖数、字形数。
字形集合写死在脚本里（GB2312 按区位逐格解码），不依赖系统字体，换机器得到同一套字符。

验证（可选，用 fontTools 独立打开产物）：

```bash
python - <<'PY'
from fontTools.ttLib import TTFont
f = TTFont("assets/fonts/lxgw-wenkai-hand.woff2")
cm = f.getBestCmap()
print("numGlyphs", f["maxp"].numGlyphs, "cmap", len(cm))
spot = "屿纸便签待办紧急解决慢做宜书写读书散步早睡归整理信远眺发呆留白独处加减删除废纸篓恢复"
print("spot", sum(ord(c) in cm for c in spot), "/", len(spot))
PY
```

### 等价的裸 pyftsubset 命令（已实测与脚本产物逐字节一致）

脚本只是把下面这组参数固化下来的封装；字符表由脚本生成到 `target_chars.txt`（7549 个码位）。

```bash
python -m fontTools.subset LXGWWenKai-Regular.ttf \
  --output-file=lxgw-wenkai-hand.woff2 \
  --flavor=woff2 --no-hinting --desubroutinize --notdef-outline --recalc-bounds \
  --name-IDs='*' --name-languages='*' --name-legacy --layout-features='*' \
  --no-recalc-timestamp --drop-tables+=DSIG \
  --text-file=target_chars.txt
```

实测（fonttools 4.67.0 + brotli 1.2.0）：裸命令产物与 `tools/subset_font.py` 产物
SHA-256 相同（`56731348…4e0c1c`）。注意 `--recalc-bounds` 不能省：省掉会保留
上游 26MB 全字体的 head/hhea/maxp 极值（`xMax=2988` 等），虽然浏览器仍能渲染，
但元数据与实际字形不符。

## 使用方注意

- 页面在 iframe `srcdoc` 里运行（`srcdoc` 的 base URL 是父文档），相对 URL 解析不到
  插件包内文件；`@font-face` 的 `src` 必须指向宿主路由（由插件 `index.js` 注册）或
  内联 data URL，不能用 `url("assets/fonts/lxgw-wenkai-hand.woff2")` 这种包内相对路径。
- `@font-face` 的 `font-family` 要与页面用的名字一致：产物 name 表里的族名是
  **`LXGW WenKai`**（子集未改 name 表），页面 `--font-hand-builtin` 也写的 `"LXGW WenKai"`，
  两边对得上。声明示例：

  ```css
  @font-face {
    font-family: "LXGW WenKai";
    src: url("<宿主路由>/font/lxgw-wenkai-hand.woff2") format("woff2");
    font-display: swap;
  }
  ```

- 兜底写法（本字体在前，系统字体兜底）：
  `"LXGW WenKai", "Kaiti SC", KaiTi, "STKaiti", cursive` —— 子集外的字自动落到系统字体。
- 若将来换版本：改 `tools/subset_font.py` 顶部的 `SOURCE_URL` / `SOURCE_SHA256` /
  `SOURCE_VERSION`，重跑并同步更新本文件。