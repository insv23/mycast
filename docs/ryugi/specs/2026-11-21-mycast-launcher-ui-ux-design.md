# MyCast 启动器 UI/UX 设计

批准日期：2026-11-21。来源：Ryugi 文档 `document/mycast-launcher-ui-ux-design` 与画板 `artboard/app-shell-navigation`。

## 意图

MyCast 的一切入口都是 Raycast 式搜索窗口：搜索应用回车直接打开应用，搜索功能回车打开该功能自己的窗口。与 Raycast 的区别是键盘映射、剪贴板、片段、插件各自拥有独立窗口，可以同时留在屏幕上，并各自在键盘映射里绑定快捷键。视觉风格以用户提供的参考图为准。

本设计只覆盖 UI 和 UX 交互；插件 API 与 moe.js 兼容另起设计。

## 已定决策

- 入口是纯搜索面板。
- 搜索结果按参考图排布：搜索框、分组标题、行尾类型标签、底部 Open Command 与 Actions。
- 设置是独立窗口，从搜索窗用 ⌘, 进入，设置项也用搜索布局；语言只有中文、English、跟随系统。
- 插件命令就是搜索结果里的一条普通 Command，不加来源、徽标或分组；设置页里每个插件有自己的内容。
- 插件命令回车后打开插件自己的独立窗口；第三轮只保留窗口行为，不保留带插件标记的列表样式。
- 视觉取值：主表面 `#ebebeb`，抬升 `#f3f3f3`，选中行 `#d5d5d5`，文字 `#1d1d1f / #6e6e73 / #9a9aa0`，强调色 `#ff5a5f`；窗口圆角 14px，行 8px，键帽 5px；搜索窗按你后来的纠正改为固定 720×440、不可缩放、不显示红绿灯；设置窗仍按搜索式布局设计，尺寸待做设置页时再定；搜索框 76px，结果行 48px，底栏 60px。搜索框不放大镜图标，也不放 Ask AI / Tab；文字用系统字体默认渲染并加粗到 600，不用 antialiased 把字变细；底栏是普通实心灰色条（#e4e4e4）加一条顶部细线，不用毛玻璃；键帽是扁平灰块，无阴影、无高光、无渐变，键与键之间固定 4px 间距。
- 深色主题不在本设计内，沿用现有适配作为后续工作。
- 默认命令第一版：打开键盘映射、剪贴板历史、片段、表情与符号、切换系统外观、打开设置。其中键盘映射先落地，其余留作后续切片。

## 第一批实现范围

1. 主窗口改为 `/launcher` 搜索窗。
2. `Registry` 注册内置 Command：`keyboard-mapping`。
3. 回车通过 `Service.openCommand(id)` 打开独立窗口 `/keyboard`，加载现有键盘映射界面。
4. 重复打开同一命令时聚焦已有窗口；命令窗关闭后从窗口表移除。
5. `Ctrl+Option+Space` 全局快捷键唤起或隐藏搜索窗；Escape 隐藏搜索窗。
6. 保留 helper、菜单栏、单实例锁的现有行为。

## 接口约定

Go 侧：

```go
type Command struct {
    ID, Title, Subtitle, Type, Shortcut string
    Keywords []string
    Run func()
}

type Registry struct{ /* ... */ }

func (r *Registry) Register(cmd Command)
func (r *Registry) Search(query string) []CommandInfo
func (r *Registry) Open(id string) bool
```

页面通过生成的绑定调用：`Service.commands(query)`、`Service.openCommand(id)`、`Service.hideLauncher()`。

## 记录过的画板

- 画板：`artboard/app-shell-navigation`，本地路径 `.ryugi/artifacts/artboard/app-shell-navigation/`。
- 文档：`document/mycast-launcher-ui-ux-design`，链接见 Ryugi artifacts 服务器。
- 第一轮定入口；第二轮定功能窗、结果列表、设置窗；第二轮的插件选项未采纳；第三轮只保留插件独立窗口的行为。
