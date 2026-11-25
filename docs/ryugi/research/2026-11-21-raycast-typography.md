# Raycast 字体规范调查

调查日期：2026-11-21。问题是：MyCast 的 Raycast 式搜索窗到底该用什么字体、字号和字重？当前 600 字重过重，需要按参考图收回来。

## 证据来源

一级证据，来自本机 Raycast 应用本身：

- `/Applications/Raycast.app/Contents/Info.plist` 里 `ATSApplicationFontsPath = "."`，说明应用加载随包字体。
- `/Applications/Raycast.app/Contents/Resources/` 里有 `Inter-Light.otf`、`Inter-Regular.otf`、`Inter-Medium.otf`、`Inter-SemiBold.otf`、`Inter-Bold.otf`，以及斜体版本；等宽字体是 `JetBrainsMono-*.ttf`、`GeistMono-Medium.ttf`。
- `/Applications/Raycast.app/Contents/Resources/RaycastWeb_RaycastWeb.bundle/Contents/Resources/fonts/` 里有 `InterVariable.woff2` 和 `JetBrainsMono.woff2`。
- 同一 bundle 的 `css/index.css` 声明 `InterVariable-RN` 为 `font-weight: 400 900`，字体栈是 `InterVariable-RN, InterVariable, SF Pro Display, -apple-system, BlinkMacSystemFont, Open Sans, Helvetica Neue, sans-serif`，并开启 `font-feature-settings: "liga" 1, "calt" 1, "kern" 1, "tnum" 1, "ss01" 1, "ss03" 1`。这段来自 Raycast 的 Web 面板，不是主启动器原生界面，但它是 Raycast 自己的资源。
- 用户提供的参考截图显示：结果标题是中等字重，副标题和右侧类型更轻；搜索占位文字大但轻；底部动作文字也就是中等字重，没有使用 Semibold/Bold 那种粗度。

二级证据，来自第三方对 raycast.com 的测量，可信度低于应用资源，只作旁证：

- https://www.shadcn.io/design/raycast
- https://www.xtractly.app/brands/raycast/fonts

它们都指向 Inter 作为主要字体，常见字重为 400/500/600，等宽用 Geist Mono 或 JetBrains Mono。它们测量的是网站，不是启动器内部，所以不能拿来直接定原生 UI 的字号。

一级证据，字体本身：

- Inter 官方站 https://rsms.me/inter/ 说明 Inter 是自由开源字体，遵循 SIL Open Font License 1.1；官方 Web 用法是 `font-family: Inter, sans-serif` 并开启 `liga` 和 `calt`。
- Inter 项目：https://github.com/rsms/inter ，许可证：https://raw.githubusercontent.com/rsms/inter/v4.1/LICENSE.txt

## 结论

Raycast 的字体判断是：**Inter 为主，JetBrains Mono 为等宽 companion；文字层级主要靠字号、颜色和 400/500 两档字重，不靠 600/700 的粗体。**

本机应用里虽然有 Inter 的 Light 到 Bold 全套字重和可变字体，但参考截图里的搜索窗不是粗体风格。结果标题用 500 最贴近；副标题、右侧类型、占位文字用 400；分组标题和底部动作用 500。键帽字符用等宽字体的 500，保持键位字符宽度稳定。

`ss01` 和 `ss03` 是 Raycast 自己 CSS 里开启的 Inter 风格集，属于可复用的细节；不需要复制 Raycast 的字体文件，应该从 Inter 官方获取可变字体并附带 OFL 许可证。

不要加 `-webkit-font-smoothing: antialiased`；macOS 上它会把 Inter 渲染得更细，和我们想要的中等字重观感冲突。

## 建议 MyCast 采用的字体规范

字体文件：

- 自托管 Inter Variable，文件名 `InterVariable.woff2`，从 https://rsms.me/inter/ 或 https://github.com/rsms/inter 获取。
- 自托管 JetBrains Mono，用于键帽、代码、快捷键字符。
- 附带 Inter 与 JetBrains Mono 的 OFL 许可证。

全局字体栈：

```css
font-family: InterVariable, Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
font-feature-settings: "liga" 1, "calt" 1, "kern" 1, "tnum" 1, "ss01" 1, "ss03" 1;
```

搜索窗 token：

| Token | 字体 | 字号 | 字重 | 行高 | 字距 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `text-search` | InterVariable | 22px | 400 | 1.2 | 0 | 搜索框占位和输入 |
| `text-section` | InterVariable | 14px | 500 | 1.4 | 0 | Suggestions / 命令 分组标题 |
| `text-row-title` | InterVariable | 16px | 500 | 1.4 | 0 | 结果主标题 |
| `text-row-subtitle` | InterVariable | 14px | 400 | 1.4 | 0 | 来源、说明、副标题 |
| `text-row-type` | InterVariable | 14px | 400 | 1.4 | 0 | Command / Application 类型 |
| `text-footer-label` | InterVariable | 14px | 500 | 1.4 | 0 | Open Command / Actions |
| `text-keycap` | JetBrains Mono | 12px | 500 | 1 | 0 | 键帽字符 |
| `text-code` | JetBrains Mono | 13px | 400 | 1.5 | 0 | 代码和数值 |

规则：

1. 主标题只用 500，不用 600。
2. 副标题、类型、占位文字用 400。
3. 分组标题和底栏动作标签用 500。
4. 键帽用 JetBrains Mono 500；键帽本身保持扁平灰块，无阴影、无高光。
5. 不开启 `-webkit-font-smoothing: antialiased`。
6. 字体特性按 Raycast 自家的 CSS 开启 `liga / calt / kern / tnum / ss01 / ss03`。

## 置信度与限制

字体家族、可变字重范围和 OpenType 特性来自本机 Raycast 资源，可信度高。具体原生启动器的点字号和字重没有从二进制中读出直接常量，规范里的数值是结合截图比例和 Raycast Web CSS 推断，可信度中等；最可靠的校准方式是把 400/500 两档应用到搜索窗后，与参考截图并排看。

此规范已应用到搜索窗：Inter Variable 与 JetBrains Mono 已自托管在 `src/assets/fonts/`，CSS 已按 400/500 两档字重调整。
