# 第五、六阶段：规则研究与公开发布

## 第五阶段

1. `analysis.py`：版本化冷暖、宏观规则解读、行业观察、有限成分个股筛选及纸面跟踪。
2. `providers.py`：新浪分页报价池验证，完整覆盖门槛、同日终对齐；东方财富前复权个股OHLC。限速、超时和有界重试。
3. `pipeline.py`：按模块独立采集与降级；量价不满足或市场过滤关闭时允许零候选。
4. 前端：分数依据、宏观事实与判断、行业条件和风险、相关标题、观察解释及跟踪空状态。
5. 回归：30项Python与26项前端测试通过，包括T+1、跳空、过期、成本、复权变化、源缺日与公开裁剪。

11-20真实验证：31行业、9项国际观测、59条保留新闻；市场温度36.4/100。研究成分池18只；沪深300低于20日均线，观察池为空。温度是规则分数，不是收益概率，未用历史结果拟合。行业热度缺日限制仍在。

## 第六阶段

1. `scripts/release.py`：交易日检查 → 采集计算 → 公开简报裁剪。
2. `.github/workflows/refresh.yml`：代码推送、手动、三个固定时点触发；测试、采集、构建、状态保留及 Pages 发布。计划时刻非时效保证，GitHub Actions可能排队。
3. `state`分支：公开简报与纸面状态；不上传原始响应，不存放账号密钥。
4. Pages：静态公开站点，访客仅GET资料，无需授权。管理使用GitHub现有权限，前台不保存Token。
5. 发布验收：检查Actions实际成功、公开HTML和JSON、项目子路径、四模块与手机宽度。运行结果以GitHub工作流记录为准。

公开地址：https://tansitanding.github.io/market-weather/
管理入口：https://github.com/tansitanding/market-weather/actions/workflows/refresh.yml

## 运维

- 采集失败：模块沿用最近有效数据并标注旧资料。不要以网页发布时间替代行情日期。
- 全站发布异常：检查Actions失败步骤，现有Pages内容继续保留。
- 手动：Actions → Refresh and publish market weather → Run workflow。
- 每年底更新`config/calendar-cn-YYYY.json`的官方休市范围；未知年不猜测交易日，研究指标安全降级。
- GitHub计划任务长期无仓库活动可能暂停，应检查Actions是否启用和最近运行记录。
- 行业源缺日：找到可靠来源后核验同口径并增加测试，再恢复热度；不前向填充。
