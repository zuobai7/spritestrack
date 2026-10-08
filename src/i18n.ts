/** Tiny i18n: Chinese and English UI strings. */
type Dict = Record<string, string>;

const zh: Dict = {
  appTagline: '开源体素编辑器',
  new: '新建',
  open: '打开',
  save: '保存',
  import: '导入',
  importVox: '导入 VOX',
  exportSprite: '导出精灵',
  exportModel: '导出模型',
  undo: '撤销',
  redo: '重做',
  help: '帮助',
  tools: '工具',
  toolAdd: '添加',
  toolErase: '擦除',
  toolPaint: '上色',
  toolPick: '吸色',
  toolFill: '填充',
  toolBox: '方块',
  toolLine: '直线',
  mode: '编辑模式',
  mode3d: '3D',
  modeLayer: '分层',
  mirror: '镜像',
  view: '视图',
  layer: '层',
  showAbove: '显示上方层',
  onion: '洋葱皮',
  grid: '网格',
  ao: '环境光遮蔽',
  palette: '调色板',
  addColor: '添加颜色',
  editColor: '修改颜色',
  removeColor: '删除未用颜色',
  model: '模型',
  size: '尺寸',
  resize: '调整尺寸',
  transform: '变换',
  flipX: '翻转 X',
  flipY: '翻转 Y',
  flipZ: '翻转 Z',
  rotate: '旋转 90°',
  clear: '清空',
  animation: '动画',
  frames: '帧',
  addAnim: '新动画',
  renameAnim: '重命名',
  deleteAnim: '删除动画',
  addFrame: '新帧',
  dupFrame: '复制帧',
  deleteFrame: '删除帧',
  moveLeft: '左移',
  moveRight: '右移',
  play: '播放',
  pause: '暂停',
  fps: '帧率',
  preview: '精灵预览',
  voxels: '体素',
  confirmNew: '新建项目？未保存的修改会丢失。',
  confirmClear: '清空当前帧？',
  confirmDeleteAnim: '删除这个动画？',
  promptAnimName: '动画名称',
  newSize: '新尺寸（宽 x 高 x 深），例如 32x32x32',
  invalidSize: '尺寸无效，每个方向 1 到 256',
  loadError: '无法打开文件：',
  saved: '已保存',
  exportSpriteTitle: '导出精灵（3D 转 2D）',
  exportModelTitle: '导出 3D 模型',
  method: '渲染方式',
  methodStack: '切片堆叠（像素精确）',
  method3d: '3D 渲染（带光照）',
  methodSlices: '原始切片条（游戏引擎用）',
  angles: '角度数',
  startAngle: '起始角度',
  scale: '像素放大',
  spacing: '层间距',
  squash: '俯视压缩',
  elevation: '仰角',
  pixelSize: '输出尺寸',
  outline: '描边',
  shading: '明暗',
  animations: '动画',
  allAnims: '全部动画',
  currentAnim: '当前动画',
  currentFrame: '仅当前帧',
  layout: '输出格式',
  layoutSheet: '精灵表 PNG + JSON',
  layoutZip: '单帧 PNG（ZIP）',
  sliceDir: '方向',
  horizontal: '横向',
  vertical: '纵向',
  format: '格式',
  modelScale: '体素大小',
  center: '居中',
  frameScope: '导出帧',
  export: '导出',
  cancel: '取消',
  close: '关闭',
  helpText: `<h3>操作</h3>
<ul>
<li><b>左键</b>：使用当前工具；在“添加”工具下按住拖动可连续放置</li>
<li><b>右键拖动</b> 或 <b>Alt + 左键</b>：旋转视角；<b>中键</b>：平移；<b>滚轮</b>：缩放</li>
<li><b>Shift + 左键</b>：添加/方块工具变为擦除</li>
<li><b>分层模式</b>：只在当前层上绘制，像画像素画一样，用 <b>Q / E</b> 或 <b>PageUp / PageDown</b> 切换层</li>
</ul>
<h3>快捷键</h3>
<ul>
<li>B 添加 · X 擦除 · P 上色 · I 吸色 · G 填充 · R 方块 · L 直线</li>
<li>Tab 切换 3D/分层 · Ctrl+Z 撤销 · Ctrl+Y / Ctrl+Shift+Z 重做 · Ctrl+S 保存</li>
<li>空格 播放/暂停 · , / . 上一帧/下一帧 · 1–9 选择颜色</li>
</ul>`,
};

const en: Dict = {
  appTagline: 'open-source voxel editor',
  new: 'New',
  open: 'Open',
  save: 'Save',
  import: 'Import',
  importVox: 'Import VOX',
  exportSprite: 'Export sprites',
  exportModel: 'Export model',
  undo: 'Undo',
  redo: 'Redo',
  help: 'Help',
  tools: 'Tools',
  toolAdd: 'Add',
  toolErase: 'Erase',
  toolPaint: 'Paint',
  toolPick: 'Pick',
  toolFill: 'Fill',
  toolBox: 'Box',
  toolLine: 'Line',
  mode: 'Edit mode',
  mode3d: '3D',
  modeLayer: 'Layer',
  mirror: 'Mirror',
  view: 'View',
  layer: 'Layer',
  showAbove: 'Show layers above',
  onion: 'Onion skin',
  grid: 'Grid',
  ao: 'Ambient occlusion',
  palette: 'Palette',
  addColor: 'Add color',
  editColor: 'Edit color',
  removeColor: 'Remove unused colors',
  model: 'Model',
  size: 'Size',
  resize: 'Resize',
  transform: 'Transform',
  flipX: 'Flip X',
  flipY: 'Flip Y',
  flipZ: 'Flip Z',
  rotate: 'Rotate 90°',
  clear: 'Clear',
  animation: 'Animation',
  frames: 'Frames',
  addAnim: 'New animation',
  renameAnim: 'Rename',
  deleteAnim: 'Delete animation',
  addFrame: 'New frame',
  dupFrame: 'Duplicate',
  deleteFrame: 'Delete frame',
  moveLeft: 'Move left',
  moveRight: 'Move right',
  play: 'Play',
  pause: 'Pause',
  fps: 'FPS',
  preview: 'Sprite preview',
  voxels: 'voxels',
  confirmNew: 'Start a new project? Unsaved changes will be lost.',
  confirmClear: 'Clear the current frame?',
  confirmDeleteAnim: 'Delete this animation?',
  promptAnimName: 'Animation name',
  newSize: 'New size (W x H x D), e.g. 32x32x32',
  invalidSize: 'Invalid size, each axis must be 1 to 256',
  loadError: 'Could not open file: ',
  saved: 'Saved',
  exportSpriteTitle: 'Export sprites (3D to 2D)',
  exportModelTitle: 'Export 3D model',
  method: 'Method',
  methodStack: 'Slice stacking (pixel exact)',
  method3d: '3D render (lit)',
  methodSlices: 'Raw slice strip (for engines)',
  angles: 'Angles',
  startAngle: 'Start angle',
  scale: 'Pixel scale',
  spacing: 'Layer spacing',
  squash: 'Top-down squash',
  elevation: 'Elevation',
  pixelSize: 'Output size',
  outline: 'Outline',
  shading: 'Shading',
  animations: 'Animations',
  allAnims: 'All animations',
  currentAnim: 'Current animation',
  currentFrame: 'Current frame only',
  layout: 'Output',
  layoutSheet: 'Sprite sheet PNG + JSON',
  layoutZip: 'One PNG per frame (ZIP)',
  sliceDir: 'Direction',
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  format: 'Format',
  modelScale: 'Voxel size',
  center: 'Center',
  frameScope: 'Frames',
  export: 'Export',
  cancel: 'Cancel',
  close: 'Close',
  helpText: `<h3>Controls</h3>
<ul>
<li><b>Left click</b>: use the current tool; drag with Add to keep placing</li>
<li><b>Right drag</b> or <b>Alt + left drag</b>: orbit; <b>Middle</b>: pan; <b>Wheel</b>: zoom</li>
<li><b>Shift + click</b>: Add/Box tools erase instead</li>
<li><b>Layer mode</b>: draw on one slice like pixel art; change layer with <b>Q / E</b> or <b>PageUp / PageDown</b></li>
</ul>
<h3>Shortcuts</h3>
<ul>
<li>B add · X erase · P paint · I pick · G fill · R box · L line</li>
<li>Tab toggles 3D/Layer · Ctrl+Z undo · Ctrl+Y / Ctrl+Shift+Z redo · Ctrl+S save</li>
<li>Space play/pause · , / . previous/next frame · 1–9 pick color</li>
</ul>`,
};

const dicts: Record<string, Dict> = { zh, en };

function initialLang(): string {
  try {
    const saved = localStorage.getItem('spritestrack.lang');
    if (saved && dicts[saved]) return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang = initialLang();

export function t(key: string): string {
  return dicts[lang][key] ?? dicts.en[key] ?? key;
}

export function getLang(): string {
  return lang;
}

export function setLang(l: string): void {
  if (!dicts[l]) return;
  lang = l;
  try {
    localStorage.setItem('spritestrack.lang', l);
  } catch {
    /* ignore */
  }
}
