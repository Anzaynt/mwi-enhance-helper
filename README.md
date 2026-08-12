# Milkyway Idle 强化助手 / Enhance Helper

[English](#english)

这是一个用于 **Milkyway Idle** 的用户脚本，面向以强化和市场交易为主的玩家。它的目标是帮助筛选可能赚钱的强化项目，并结合自己的市场成交记录统计近期强化收益。

## 功能

- 根据市场报价估算强化投入、成品价值和预期收益。
- 从游戏的强化完成消息读取最终强化等级；只有拿到服务器最终等级的批次才会进入收益账本。
- 使用个人市场成交记录，以 FIFO（先进先出）方式把售出成品和对应强化批次关联，显示实际成交收益。
- 显示掉落与经验记录中的强化结果和账本状态。
- 在“强化收益”面板中查看、筛选、导出和清空当前账本。

## 安装与自动更新

1. 安装浏览器用户脚本管理器，例如 Tampermonkey 或 Violentmonkey。
2. 打开 [mwi-enhance-helper.user.js](https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js) 并确认安装。
3. 脚本管理器会使用脚本头部的更新地址检查更新。若未自动更新，可从上面的链接重新安装。

## 使用说明

- 进入游戏后，脚本会在掉落与经验记录附近显示“强化收益”入口。
- 强化完成后，打开掉落与经验记录；脚本收到带最终装备等级的服务器完成消息后，会自动保存该批次。
- 卖出强化成品后，再打开“强化收益”即可看到与市场成交记录对应的实际收益。
- 新版账本从空白开始，以避免旧版本曾保存的未确认记录影响计算。

## 数据与限制

- 所有记录保存在浏览器本地；脚本不会上传市场记录或角色数据。
- 只有脚本运行期间捕获到的强化完成消息和市场记录能用于精确对账。
- 如果缺少最终等级完成包，脚本会明确标为“未入账”，不会根据掉落分布猜测最终等级。

## 致谢与贡献

本项目整合、改造了社区中多位作者的 Milkyway Idle 用户脚本思路与片段；原始脚本头部保留了已知作者署名（包括 wangchyan、柒雨、PaperCat 等）。感谢这些前人的工作。

该项目由 GPT 协助开发、排查和整理，人类负责需求、验证和发布。欢迎提交 Issue 或 Pull Request，尤其欢迎提供可复现的强化完成包、市场成交包或 Bug 截图来帮助修复问题。

## 许可证

[MIT](LICENSE)

---

<a id="english"></a>

# Milkyway Idle Enhance Helper

This userscript for **Milkyway Idle** is aimed at players who enhance items and trade them on the market. It helps identify potentially profitable enhancement projects and tracks recent enhancement profit using the player's own market activity.

## Features

- Estimates enhancement input cost, output value, and expected profit from market quotes.
- Reads the final enhancement level from the game's server completion message; only batches with a server-confirmed final level enter the profit ledger.
- Matches sold enhanced items to enhancement batches with FIFO accounting and shows realized sale profit when available.
- Adds enhancement-result and ledger status to the loot/experience log.
- Provides an Enhancement Profit panel for viewing, filtering, exporting, and clearing the current ledger.

## Installation and updates

1. Install a userscript manager such as Tampermonkey or Violentmonkey.
2. Open [mwi-enhance-helper.user.js](https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js) and confirm installation.
3. Your userscript manager checks the update URL in the metadata automatically. Reinstall from the link above if an update is not detected.

## Usage

- Open the game and use the **Enhancement Profit** entry near the loot/experience log.
- After an enhancement queue finishes, open the loot/experience log. The batch is saved automatically once the script receives the server packet containing the final item level.
- After selling the enhanced item, reopen **Enhancement Profit** to view the matched realized result.
- The new ledger intentionally starts empty so provisional records written by older versions cannot corrupt new calculations.

## Data and limitations

- Data stays in the browser locally; the script does not upload character or market data.
- Exact accounting requires the script to observe both the enhancement completion packet and market activity while it is running.
- A missing final-level packet is shown as **not recorded**. The script never guesses a final level from the distribution of intermediate drops.

## Credits and contributions

This project integrates and adapts ideas and portions from several community Milkyway Idle userscripts. Known original authors remain credited in the source metadata, including wangchyan, 柒雨, and PaperCat. Thank you to everyone whose earlier work made this project possible.

GPT assisted with implementation, debugging, and documentation; a human directed the requirements, testing, and release. Bug reports and pull requests are welcome. Reproducible completion packets, market packets, or screenshots are particularly helpful when reporting a bug.

## License

[MIT](LICENSE)
