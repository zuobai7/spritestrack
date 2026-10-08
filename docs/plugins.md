# 插件：程序化生成器

[English](plugins.en.md)

SpriteStrack 的“生成”对话框里的每一项都是一个**生成器**：给定几个参数，往体素网格里填内容。除了内置的地形、树、岩石、基础形状、房屋、火焰，你可以写自己的生成器，有两种方式：

- **自定义脚本**：在“生成”对话框里选“自定义脚本”，直接写 JavaScript。适合一次性的东西。
- **插件**：写一个 `.js` 文件注册生成器，可以带参数界面、分享给别人。

## 加载插件

- 顶栏 **导入 → 加载插件（.js）**，选中文件。文件会作为 ES 模块运行。
- 也可以在浏览器控制台里直接运行插件代码。
- 自己部署的版本可以在 `index.html` 里加 `<script type="module" src="./my-plugin.js"></script>`（放在 `src/main.ts` 之后）。

可以先试试示例插件 [examples/spiral-tower.js](examples/spiral-tower.js)。

## `window.SpriteStrack`

| 成员 | 说明 |
| --- | --- |
| `registerGenerator(generator)` | 注册生成器；`id` 相同会替换旧的 |
| `getGenerators()` | 已注册的生成器列表 |
| `version` | 程序版本 |
| `isDesktop` | 是否在桌面版里运行 |
| `editor` | 编辑器对象（高级用法，接口以后可能变化） |

## 写一个生成器

```js
SpriteStrack.registerGenerator({
  id: 'pillar', // 唯一 id
  name: { zh: '柱子', en: 'Pillar' }, // 也可以只写一个字符串
  description: { zh: '一根带柱头的圆柱', en: 'A round pillar with a capital' }, // 可选
  animated: false, // 结果随 ctx.t 变化时设为 true，才能“生成新动画”
  params: [
    { key: 'radius', label: { zh: '半径', en: 'Radius' }, type: 'number', default: 3, min: 1, max: 16, step: 0.5 },
    { key: 'color', label: { zh: '颜色', en: 'Color' }, type: 'color', default: '#8b9bb4' },
    { key: 'capital', label: { zh: '柱头', en: 'Capital' }, type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const c = ctx.color(p.color);
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    for (let y = 0; y < ctx.sy; y++) ctx.sphere(cx, y + 0.5, cz, p.radius, c, 0.5);
    if (p.capital) ctx.box(cx - p.radius - 1, ctx.sy - 2, cz - p.radius - 1, cx + p.radius, ctx.sy - 1, cz + p.radius, c);
  },
});
```

### 参数类型

| `type` | 界面 | 值 |
| --- | --- | --- |
| `int` | 滑块，步长 1 | 数字 |
| `number` | 滑块，用 `min` / `max` / `step` | 数字 |
| `bool` | 勾选框 | `true` / `false` |
| `color` | 取色器 | `'#rrggbb'` 字符串 |
| `select` | 下拉框，`options: [{ value, label }]` | 选中项的 `value` |

`label` 和 `options[].label` 都可以写成 `{ zh, en }`，会跟着界面语言切换。

### `ctx` 接口

| 成员 | 说明 |
| --- | --- |
| `sx`, `sy`, `sz` | 模型尺寸（宽、高、深） |
| `t` | 动画时间，范围 `[0, 1)`；生成单帧时为 0 |
| `frame`, `frameCount` | 当前是第几帧、一共几帧 |
| `rand()` | 由种子决定的随机数 `[0, 1)` |
| `randInt(min, max)` | 随机整数，包含两端 |
| `noise2(x, y)`, `noise3(x, y, z)` | Perlin 噪声，约 `[-1, 1]` |
| `fbm2(x, y, octaves?)`, `fbm3(x, y, z, octaves?)` | 多层叠加的噪声 |
| `get(x, y, z)` | 读取体素（调色板序号，0 为空） |
| `set(x, y, z, color)` | 写入体素；坐标会向下取整，超出范围会被忽略，`color` 为 0 表示擦除 |
| `box(x0, y0, z0, x1, y1, z1, color)` | 填充长方体（包含两端） |
| `sphere(cx, cy, cz, rx, color, ry?, rz?)` | 填充球体或椭球 |
| `color('#rrggbb' 或 0xrrggbb)` | 返回颜色在调色板里的序号；没有就加进去，调色板满了就用最接近的颜色 |
| `clear()` | 清空 |

### 约定

- **坐标**：x 向右，y 向上，z 朝向正面视角的观察者。体素 `(x, y, z)` 占据 `[x, x+1) × [y, y+1) × [z, z+1)`，所以中心在 `x + 0.5`。
- **随机**：请用 `ctx.rand`、`ctx.randInt` 和噪声函数，这样同一个种子总能得到同样的结果。`Math.random()` 会让“随机种子”失效。
- **动画**：选“生成新动画”时，`generate` 每帧调用一次，`ctx.t = frame / frameCount`。用 `Math.sin(2 * Math.PI * ctx.t)` 这样的周期函数，动画就能无缝循环。
- **叠加**：选“叠加到当前帧”时，网格一开始就是当前帧的内容，可以用 `ctx.get` 读取再修改。
- **颜色**：调色板最多 255 种颜色。新颜色会加到当前配色里；其他配色缺少的序号会自动用当前配色的颜色补上。

## 自定义脚本

“生成”对话框里的“自定义脚本”就是 `generate(ctx, params)` 的函数体，可以使用同样的 `ctx`。脚本在后台线程（Web Worker）里运行：

- 预览超过 5 秒会被自动停止，所以死循环不会卡住编辑器；
- 不能访问页面（没有 `document`、`window.SpriteStrack`）；
- 写好的脚本会保存在浏览器里，下次打开还在。
