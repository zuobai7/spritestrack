// Example SpriteStrack plugin: a spiral tower generator.
// 示例插件：螺旋塔生成器。
//
// Load it in the editor with Import → Load plugin (.js), then open Generate.
// 在编辑器里点“导入 → 加载插件（.js）”选中这个文件，然后打开“生成”。

SpriteStrack.registerGenerator({
  id: 'example-spiral-tower',
  name: { zh: '螺旋塔（示例插件）', en: 'Spiral tower (example)' },
  description: {
    zh: '空心圆塔，外墙绕着一圈螺旋装饰；生成动画时螺旋会旋转',
    en: 'A hollow round tower wrapped in a spiral band that turns when animated',
  },
  animated: true,
  params: [
    { key: 'radius', label: { zh: '半径', en: 'Radius' }, type: 'number', default: 0.4, min: 0.15, max: 0.5, step: 0.05 },
    { key: 'turns', label: { zh: '圈数', en: 'Turns' }, type: 'int', default: 2, min: 1, max: 6 },
    { key: 'stone', label: { zh: '墙颜色', en: 'Wall color' }, type: 'color', default: '#8b9bb4' },
    { key: 'band', label: { zh: '螺旋颜色', en: 'Spiral color' }, type: 'color', default: '#feae34' },
    { key: 'roof', label: { zh: '尖屋顶', en: 'Pointed roof' }, type: 'bool', default: true },
  ],
  generate(ctx, p) {
    const stone = ctx.color(p.stone);
    const band = ctx.color(p.band);
    const roof = ctx.color('#a22633');
    const cx = ctx.sx / 2;
    const cz = ctx.sz / 2;
    const r = Math.min(ctx.sx, ctx.sz) * p.radius;
    const top = p.roof ? Math.floor(ctx.sy * 0.7) : ctx.sy;
    for (let y = 0; y < top; y++)
      for (let z = 0; z < ctx.sz; z++)
        for (let x = 0; x < ctx.sx; x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          const d = Math.hypot(dx, dz);
          if (d > r || d < r - 1.6) continue; // wall about 1.5 voxels thick
          // Position along the spiral: angle around the tower plus height, shifted by animation time
          const a = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
          const s = (((a + (y / top) * p.turns - ctx.t) % 1) + 1) % 1;
          ctx.set(x, y, z, s < 0.14 ? band : stone);
        }
    if (p.roof)
      for (let y = top; y < ctx.sy; y++) {
        const rr = (r + 1) * (1 - (y - top) / (ctx.sy - top));
        for (let z = 0; z < ctx.sz; z++)
          for (let x = 0; x < ctx.sx; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= rr) ctx.set(x, y, z, roof);
      }
  },
});
