# 2026-06-25 14:50:57 +08:00 - 网站 favicon 缩略图

## 改动内容
- 从用户选择的第 4 个候选图标中裁出原始图案，作为网站 favicon。
- 新增文件：
  - `public/favicon.png`
- 修改 `index.html`，增加：
  - `<link rel="icon" type="image/png" href="/favicon.png" />`

## 为什么做这个改动
- 浏览器标签页之前显示默认图标，无法体现 Running Platform 的产品识别。
- 用户选择了第 4 个候选方案：路线轨迹 + 心率图标。

## 解决的问题
- 让浏览器标签页、收藏夹等位置显示 Running Platform 的自定义缩略图。
- 使用用户选择的第 4 个候选图标原样裁剪，没有重新生成或改动设计。

## 说明
- 图标来自此前生成的 6 宫格候选图左下角第 4 个方案。
- 本次只做裁剪和 HTML 引用，不做重新绘制、不改颜色、不改造型。
- 当前只添加 PNG favicon；后续如需要更完整的 PWA/手机桌面图标，可再补 `apple-touch-icon` 和 manifest。

## 验证
- `npm run build` 通过。
- 构建仍有 ECharts chunk 大小警告，这是既有图表包体积提示，不影响 favicon。
