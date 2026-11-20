import './style.css';
const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('missing app root');
root.innerHTML = `<span class="tag">开发骨架 · 阶段 1–3</span><h1>股市气象站</h1><p>手机优先，公开阅读无需登录。</p><p>页面统一展示最新内容；08:45、11:45、17:30 仅作为后台采集时间。</p><section><h2>下一阶段</h2><p>总览 / 行业 / 全球 / 观察四个模块将在第四阶段连接统一快照。当前没有加载演示行情冒充真实数据。</p></section><small>此页用于验证前端构建与类型契约，不是已完成的产品。</small>`;
