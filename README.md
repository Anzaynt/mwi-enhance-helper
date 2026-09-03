# Milkyway Idle 强化助手 / Enhance Helper

[English](#english)

用于 **Milkyway Idle** 的个人强化与市场分析用户脚本。它不保存强化收益账本，也不尝试推断真实历史利润；所有结果均基于当前市场价格和当前角色数据即时计算。

## 功能

- 在强化相关市场页面显示预期成本、税后收益和工时费。
- 在玩家名字左侧提供“工具箱”按钮；打开后可进入“强化榜”。
- 强化榜仅筛选有收购价的强化成品，可按工时费/h、风控工时费/h 或经验/h 排序；会在传统强化、普通强化后精炼、贤者之镜路线中选取时薪最高的可行方案。
- 强化榜使用最高收购价（Bid）和 5% 交易税计算税后收入；模拟和排序均在浏览器本地完成。
- 点击强化榜中的物品可跳转到对应 +N 市场；脚本会等待该商品订单簿刷新后只更新对应的榜单条目。
- 工具箱位置不干预游戏原生标签页，也不与其他脚本的标签切换逻辑耦合。
- 强化榜会排除强化材料中存在当前不可购买物品的项目，例如部分配饰。
- 在强化行动统计区域旁显示“停止 / 继续 EV”：历史消耗只用于本次实际盈亏，未来 EV 从当前等级开始递归比较后续的停止或继续策略。
- 停止价值只采用当前最高求购价（Bid）扣税；没有求购单会明确标示为无法即时退出，绝不以卖单替代。
- EV 以始终显示的可拖动半透明浮窗呈现；可收起为按钮，展开/收起状态和位置会保存在本地。

## 依赖与数据

- 需要安装 [MWITools](https://github.com/doh-nuts/MWITools) 以提供本地市场缓存；脚本兼容 MWITools 26.4.8 的缓存和物品名称映射。
- 强化榜启动时读取一次公开市场快照，不携带游戏登录凭据；不会按物品或订单逐项请求。
- 风控工时费还会读取 MWITools 展示或保存的流动资产；无法读取时仅隐藏风控数值，不影响普通工时费和经验/h。

## 安装与更新

1. 安装 Tampermonkey、Violentmonkey 等用户脚本管理器。
2. 打开 [mwi-enhance-helper.user.js](https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js) 并确认安装。
3. 确保 MWITools 已安装并完成市场数据加载。
4. 脚本管理器会根据脚本头部的更新地址检查更新；未自动更新时可重新打开上述链接安装。

## 使用说明

1. 进入游戏后，在玩家名字左侧点击“工具箱”。
2. 选择“强化榜”。首次打开会按当前 Buff、装备和市场快照进行完整本地计算；完成后会显示本次计算耗时。
3. 使用排行榜中的筛选、排序和“本地重算”按钮比较项目。关闭后在同一页面会话内再次打开会复用已算出的结果。
4. 完成一次强化后，在浮窗查看“强化停止 / 继续 EV”。白板成本自动取当前市场左一卖单，用于估算本次停止盈亏；不会影响未来 EV。

## 限制

- 市场报价会变化；排行榜估值不等同于实际成交价或历史成本。
- 强化榜只列出当前有有效收购价、且所有强化材料均存在可购买价格的项目。
- 强化模拟会根据角色的当前强化相关 Buff 和等级计算；贤者之镜的中间件按“恰好到达目标等级”处理，避免福气茶跨级产物被错误复用。切换 Buff、装备或市场价格后应使用“本地重算”。
- 停止 / 继续面板的行动统计仅从脚本加载后开始，短期成功/失败记录只供展示；EV 始终使用游戏当前成功率。
- 本脚本不记录个人市场交易或持久化收益数据；历史消耗按当前市场价格估值，白板取当前左一卖单。

## 许可证

[MIT](LICENSE)

---

<a id="english"></a>

# Milkyway Idle Enhance Helper

A personal enhancement and market-analysis userscript for **Milkyway Idle**. It does not keep a profit ledger or infer historical realized profit. Results are live estimates based on current market prices and current character data.

## Features

- Shows expected cost, after-tax return, and hourly value on enhancement-related market pages.
- Adds a **Toolkit** button to the left of the player name, with an **Enhancement Ranking** entry.
- Ranks only enhanced products with active buy orders, sortable by hourly value, risk-adjusted hourly value, or experience per hour.
- Uses the highest buy order (Bid) and a 5% market tax; simulation and ranking run locally in the browser.
- Does not modify the game’s native tab system or depend on other scripts’ tab switching.
- Excludes ranking projects whose enhancement costs contain an item with no currently buyable price, including some accessory categories.
- Shows a **Stop / Continue EV** panel next to enhancement action statistics. Historical consumption is used only for the current run’s realized P&L; future EV starts at the current level and recursively chooses stop or continue afterward.
- Uses only the current highest buy order (Bid), after tax, as an exit value. If no buy order exists, it explicitly reports that immediate exit cannot be valued and never substitutes an ask price.
- EV is shown in an always-available draggable translucent floating window. It can collapse to a button, and its collapsed state and position are stored locally.

## Dependencies and data

- [MWITools](https://github.com/doh-nuts/MWITools) is required for its local market cache. This script supports MWITools 26.4.8 cache and item-name mappings.
- The ranking reads one public market snapshot when the script starts, without game login credentials. It never sends one request per item or order.
- Risk-adjusted hourly value also reads the liquid-assets value exposed or stored by MWITools. If unavailable, only that column is unavailable.

## Installation and updates

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Open [mwi-enhance-helper.user.js](https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js) and confirm installation.
3. Install MWITools and let it load market data.
4. The userscript manager checks the metadata update URL automatically; reinstall from the link above if needed.

## Usage

1. In game, click **Toolkit** to the left of the player name.
2. Choose **Enhancement Ranking**. The first opening performs a full local calculation using the current buffs, equipment, and market snapshot; the elapsed time is shown when it finishes.
3. Filter, sort, or use **Recalculate locally** to compare projects. Reopening within the same page session reuses the completed result.
4. After an enhancement completes, use the floating **Stop / Continue EV** panel. The base-item cost uses the current lowest market listing to estimate the current run’s stop P&L; it does not affect future EV.

## Limitations

- Market quotes change. Rankings are not actual fill prices or historical cost basis.
- The ranking includes only products with a valid current buy order and currently buyable prices for every enhancement material.
- Simulation uses the current enhancement-related buffs and levels. Recalculate after changing buffs, equipment, or market prices.
- The panel tracks actions only after the script loads. Its short-run success/failure counts are display-only; EV always uses the game’s current success rate.
- The script does not persist personal market trades or profit data. Historical consumption is valued at current market prices, with the base item using the current lowest listing.

## License

[MIT](LICENSE)
