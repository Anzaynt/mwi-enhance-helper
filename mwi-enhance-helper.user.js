// ==UserScript==
// @name         Milkyway Idle - Enhance Helper
// @namespace    https://github.com/Anzaynt/mwi-enhance-helper
// @version      1.11.0
// @description  Header toolbox with enhancement ranking and a live stop/continue EV helper.
// @author       Anzaynt
// @license      MIT
// @homepageURL   https://github.com/Anzaynt/mwi-enhance-helper
// @supportURL    https://github.com/Anzaynt/mwi-enhance-helper/issues
// @updateURL     https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js
// @downloadURL   https://raw.githubusercontent.com/Anzaynt/mwi-enhance-helper/main/mwi-enhance-helper.user.js
// @match        https://*.milkywayidle.com/*
// @match        https://*.milkywayidlecn.com/*
// @require      https://cdn.jsdelivr.net/npm/lz-string@1.5.0/libs/lz-string.min.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    // 排行榜使用独立防重复标记，避免与旧版强化显示脚本重复初始化。
    if (window.__ENHANCE_HOURLY_RATE_RANKING__) return;
    window.__ENHANCE_HOURLY_RATE_RANKING__ = true;
    const legacyHourlyRateAlreadyRunning = Boolean(window.__ENHANCE_HOURLY_RATE_SHOW__);
    if (!legacyHourlyRateAlreadyRunning) window.__ENHANCE_HOURLY_RATE_SHOW__ = true;

    // ═══════════════════════════════════════════════
    //  常量
    // ═══════════════════════════════════════════════
    const ENHANCE_ACTION_TYPE = "/action_types/enhancing";
    const ENHANCE_SKILL_HRID = "/skills/enhancing";
    const ENHANCE_ACTION_HRID = "/actions/enhancing/enhance";
    const NS_PER_HOUR = 3600e9;
    const MIN_TIME_COST_NS = 3e9;

    const DEFAULT_TEAS = [
      "/items/ultra_enhancing_tea",
      "/items/blessed_tea",
      "/items/wisdom_tea"
    ];

    // 本地内置的中文名称后备映射；排行榜渲染时不会为了翻译名称发送网络请求。
    const PRIVATE_ZH_ITEM_NAMES = Object.freeze({
      "Currencie": "货币",
      "Food": "食物",
      "Drink": "饮料",
      "Resource": "资源",
      "Consumable": "消耗品",
      "Ability Book": "技能书",
      "Equipment": "装备",
      "Tool": "工具",
      "Coin": "硬币",
      "Basic currency": "基础货币",
      "Task Token": "任务代币",
      "Cowbell": "牛铃",
      "Bag Of 10 Cowbells": "10牛铃包",
      "Milk": "牛奶",
      "mooo": "哞",
      "Verdant Milk": "翠绿牛奶",
      "moooo": "哞哞",
      "Azure Milk": "蔚蓝牛奶",
      "mooooo": "哞哞哞",
      "Burble Milk": "深紫牛奶",
      "moooooo": "哞哞哞哞",
      "Crimson Milk": "深红牛奶",
      "mooooooo": "哞哞哞哞哞",
      "Rainbow Milk": "彩虹牛奶",
      "moooooooo": "哞哞哞哞哞哞",
      "Holy Milk": "圣奶",
      "mooooooooo": "哞哞哞哞哞哞哞",
      "Cheese": "奶酪",
      "Verdant Cheese": "翠绿奶酪",
      "Azure Cheese": "蔚蓝奶酪",
      "Burble Cheese": "深紫奶酪",
      "Crimson Cheese": "深红奶酪",
      "Rainbow Cheese": "彩虹奶酪",
      "Holy Cheese": "圣奶酪",
      "Log": "原木",
      "Birch Log": "白桦原木",
      "Cedar Log": "雪松原木",
      "Purpleheart Log": "紫心原木",
      "Ginkgo Log": "银杏原木",
      "Redwood Log": "红木",
      "Arcane Log": "神秘原木",
      "Lumber": "木板",
      "Birch Lumber": "白桦木板",
      "Cedar Lumber": "雪松木板",
      "Purpleheart Lumber": "紫心木板",
      "Ginkgo Lumber": "银杏木板",
      "Redwood Lumber": "红木板",
      "Arcane Lumber": "神秘木板",
      "Rough Hide": "粗糙兽皮",
      "Reptile Hide": "爬行动物皮",
      "Gobo Hide": "哥布林皮",
      "Beast Hide": "野兽皮",
      "Umbral Hide": "暗影皮",
      "Rough Leather": "粗糙皮革",
      "Reptile Leather": "爬行动物皮革",
      "Gobo Leather": "哥布林皮革",
      "Beast Leather": "野兽皮革",
      "Umbral Leather": "暗影皮革",
      "Cotton": "棉花",
      "Flax": "亚麻",
      "Bamboo Branch": "竹子",
      "Cocoon": "茧",
      "Radiant Fiber": "光辉纤维",
      "Cotton Fabric": "棉花布料",
      "Linen Fabric": "亚麻布料",
      "Bamboo Fabric": "竹子布料",
      "Silk Fabric": "丝绸",
      "Radiant Fabric": "光辉布料",
      "Egg": "鸡蛋",
      "Wheat": "小麦",
      "Sugar": "糖",
      "Blueberry": "蓝莓",
      "Blackberry": "黑莓",
      "Strawberry": "草莓",
      "Mooberry": "月梅",
      "Marsberry": "火星梅",
      "Spaceberry": "太空梅",
      "Apple": "苹果",
      "Orange": "橙子",
      "Plum": "李子",
      "Peach": "桃子",
      "Dragon Fruit": "火龙果",
      "Star Fruit": "杨桃",
      "Arabica Coffee Bean": "小果咖啡豆",
      "Robusta Coffee Bean": "中果咖啡豆",
      "Liberica Coffee Bean": "大果咖啡豆",
      "Excelsa Coffee Bean": "高产咖啡豆",
      "Fieriosa Coffee Bean": "火山咖啡豆",
      "Spacia Coffee Bean": "太空咖啡豆",
      "Green Tea Leaf": "绿茶叶",
      "Black Tea Leaf": "黑茶叶",
      "Burble Tea Leaf": "紫茶叶",
      "Moolong Tea Leaf": "月亮茶叶",
      "Red Tea Leaf": "红茶叶",
      "Emp Tea Leaf": "虚空茶叶",
      "Snake Fang": "蛇牙",
      "Material used in smithing Snake Fang Dirk": "用于锻造蛇牙短剑的材料",
      "Shoebill Feather": "鲸头鹳羽毛",
      "Material used in tailoring Shoebill Shoes": "用于缝鲸头鹳鞋的材料",
      "Snail Shell": "蜗牛壳",
      "Crab Pincer": "蟹钳",
      "Material used in smithing Pincer Gloves": "用于锻造螯钳手套的材料",
      "Turtle Shell": "乌龟壳",
      "Marine Scale": "海洋鳞片",
      "Treant Bark": "树皮",
      "Material used in crafting Treant Shield": "用于制作树人盾的材料",
      "Centaur Hoof": "半人马蹄",
      "Material used in tailoring Centaur Boots": "用于缝半人马靴的材料",
      "Luna Wing": "月神翼",
      "Gobo Rag": "哥布林破布",
      "Goggles": "护目镜",
      "Material used in smithing Vision Helmet": "用于锻造视觉头盔的材料",
      "Magnifying Glass": "放大镜",
      "Eye Of The Watcher": "观察者之眼",
      "Icy Cloth": "冰霜布料",
      "Flaming Cloth": "燃烧的布料",
      "Sorcerer's Sole": "魔法师的鞋底",
      "Material used in tailoring Sorcerer Boots": "用于缝魔法师靴的材料",
      "Chrono Sphere": "时空球",
      "Frost Sphere": "冰霜球",
      "Material used in crafting Frost Staff": "用于制作霜之法杖的材料",
      "Panda Fluff": "熊猫绒",
      "Material used in smithing Panda Gloves": "用于锻造熊猫手套的材料",
      "Black Bear Fluff": "黑熊绒",
      "Material used in smithing Black Bear Shoes": "用于锻造黑熊鞋的材料",
      "Grizzly Bear Fluff": "灰熊绒",
      "Polar Bear Fluff": "北极熊绒",
      "Material used in smithing Polar Bear Shoes": "用于锻造北极熊鞋的材料",
      "Red Panda Fluff": "小熊猫绒",
      "Magnet": "磁铁",
      "Material used in smithing Magnetic Gloves": "用于锻造磁力手套的材料",
      "Stalactite Shard": "钟乳石碎片",
      "Living Granite": "活花岗岩",
      "Colossus Core": "巨像核心",
      "Vampire Fang": "吸血鬼牙",
      "Werewolf Claw": "狼爪",
      "Revenant Anima": "亡者之魂",
      "Soul Fragment": "灵魂碎片",
      "Infernal Ember": "地狱余烬",
      "Demonic Core": "恶魔核心",
      "Swamp Essence": "沼泽精华",
      "Aqua Essence": "海洋精华",
      "Jungle Essence": "丛林精华",
      "Gobo Essence": "哥布林精华",
      "Eyessence": "眼球精华",
      "Sorcerer Essence": "法师精华",
      "Bear Essence": "熊精华",
      "Golem Essence": "魔像精华",
      "Twilight Essence": "暮光之城精华",
      "Abyssal Essence": "地狱精华",
      "Star Fragment": "星星碎片",
      "Pearl": "珍珠",
      "Amber": "琥珀",
      "Garnet": "石榴石",
      "Jade": "翡翠",
      "Amethyst": "紫水晶",
      "Moonstone": "月亮石",
      "Crushed Pearl": "珍珠碎片",
      "Used to be a piece of pearl": "曾经是一颗珍珠",
      "Crushed Amber": "琥珀碎片",
      "Used to be a piece of amber": "曾经是一块琥珀",
      "Crushed Garnet": "石榴石碎片",
      "Used to be a piece of garnet": "曾经是一颗石榴石",
      "Crushed Jade": "翡翠碎片",
      "Used to be a piece of jade": "曾经是一块翡翠",
      "Crushed Amethyst": "紫水晶碎片",
      "Used to be a piece of amethyst": "曾经是一颗紫水晶",
      "Crushed Moonstone": "月亮石碎片",
      "Used to be a piece of moonstone": "曾经是一块月亮石",
      "Shard Of Protection": "保护碎片",
      "Mirror Of Protection": "保护之镜",
      "Donut": "甜甜圈",
      "Blueberry Donut": "蓝莓甜甜圈",
      "Blackberry Donut": "黑莓甜甜圈",
      "Strawberry Donut": "草莓甜甜圈",
      "Mooberry Donut": "月莓甜甜圈",
      "Marsberry Donut": "火星莓甜甜圈",
      "Spaceberry Donut": "太空莓甜甜圈",
      "Cupcake": "纸杯蛋糕",
      "Blueberry Cake": "蓝莓蛋糕",
      "Blackberry Cake": "黑莓蛋糕",
      "Strawberry Cake": "草莓蛋糕",
      "Mooberry Cake": "月莓蛋糕",
      "Marsberry Cake": "火星莓蛋糕",
      "Spaceberry Cake": "太空莓蛋糕",
      "Gummy": "软糖",
      "Apple Gummy": "苹果软糖",
      "Orange Gummy": "橙子软糖",
      "Plum Gummy": "李子软糖",
      "Peach Gummy": "桃子软糖",
      "Dragon Fruit Gummy": "火龙果软糖",
      "Star Fruit Gummy": "杨桃软糖",
      "Yogurt": "酸奶",
      "Apple Yogurt": "苹果酸奶",
      "Orange Yogurt": "橙子酸奶",
      "Plum Yogurt": "李子酸奶",
      "Peach Yogurt": "桃子酸奶",
      "Dragon Fruit Yogurt": "火龙果酸奶",
      "Star Fruit Yogurt": "杨桃酸奶",
      "Milking Tea": "挤奶茶",
      "Foraging Tea": "采集茶",
      "Woodcutting Tea": "伐木茶",
      "Cooking Tea": "烹饪茶",
      "Brewing Tea": "冲泡茶",
      "Enhancing Tea": "强化茶",
      "Cheesesmithing Tea": "奶酪锻造茶",
      "Crafting Tea": "制作茶",
      "Tailoring Tea": "裁缝茶",
      "Super Milking Tea": "超级挤奶茶",
      "Super Foraging Tea": "超级采集茶",
      "Super Woodcutting Tea": "超级伐木茶",
      "Super Cooking Tea": "超级烹饪茶",
      "Super Brewing Tea": "超级冲泡茶",
      "Super Enhancing Tea": "超级强化茶",
      "Super Cheesesmithing Tea": "超级奶酪锻造茶",
      "Super Crafting Tea": "超级制作茶",
      "Super Tailoring Tea": "超级裁缝茶",
      "Gathering Tea": "收集茶",
      "Gourmet Tea": "双倍茶",
      "Wisdom Tea": "经验茶",
      "Processing Tea": "加工茶",
      "Efficiency Tea": "效率茶",
      "Artisan Tea": "工匠茶",
      "Blessed Tea": "祝福茶",
      "Stamina Coffee": "体力咖啡",
      "Intelligence Coffee": "智力咖啡",
      "Defense Coffee": "防御咖啡",
      "Attack Coffee": "攻击咖啡",
      "Power Coffee": "力量咖啡",
      "Ranged Coffee": "远程咖啡",
      "Magic Coffee": "魔法咖啡",
      "Super Stamina Coffee": "超级体力咖啡",
      "Super Intelligence Coffee": "超级智力咖啡",
      "Super Defense Coffee": "超级防御咖啡",
      "Super Attack Coffee": "超级攻击咖啡",
      "Super Power Coffee": "超级力量咖啡",
      "Super Ranged Coffee": "超级远程咖啡",
      "Super Magic Coffee": "超级魔法咖啡",
      "Wisdom Coffee": "经验咖啡",
      "Lucky Coffee": "幸运咖啡",
      "Swiftness Coffee": "迅捷咖啡",
      "Channeling Coffee": "引导咖啡",
      "Critical Coffee": "暴击咖啡",
      "Poke": "戳",
      "Pokes the targeted enemy": "戳向目标敌人",
      "Pierce": "刺",
      "Pierces the targeted enemy": "刺穿目标敌人",
      "Puncture": "穿刺",
      "Scratch": "抓挠",
      "Scratches the targeted enemy": "抓伤目标敌人",
      "Cleave": "劈砍",
      "Cleaves all enemies": "劈砍所有敌人",
      "Maim": "重砍",
      "Smack": "锤击",
      "Smacks the targeted enemy": "猛击目标敌人",
      "Sweep": "横扫",
      "Performs a sweeping attack on all enemies": "对所有敌人进行横扫攻击",
      "Stunning Blow": "重锤",
      "Quick Shot": "快速射击",
      "Takes a quick shot at the targeted enemy": "对目标敌人进行快速射击",
      "Aqua Arrow": "流水箭",
      "Flame Arrow": "火焰箭",
      "Rain Of Arrows": "箭雨",
      "Shoots a rain of arrows on all enemies": "向所有敌人射出箭雨",
      "Silencing Shot": "沉默箭",
      "Steady Shot": "稳定射击",
      "Water Strike": "流水冲击",
      "Casts a water strike at the targeted enemy": "对目标敌人射出流水",
      "Ice Spear": "冰矛",
      "Casts an ice spear at the targeted enemy": "对目标敌人施放冰矛",
      "Frost Surge": "冰霜激涌",
      "Casts frost surge at all enemies": "对所有敌人施放冰霜激涌",
      "Entangle": "缠绕",
      "Entangles the targeted enemy": "缠绕目标敌人",
      "Toxic Pollen": "毒性花粉",
      "Casts toxic pollen at all enemies": "对所有敌人施放毒性花粉",
      "Nature's Veil": "自然面纱",
      "Fireball": "火球",
      "Casts a fireball at the targeted enemy": "对目标敌人施放火球",
      "Flame Blast": "火焰冲击",
      "Casts a flame blast at all enemies": "对所有敌人施放火焰冲击",
      "Firestorm": "火焰风暴",
      "Casts a firestorm at all enemies": "对所有敌人施放火焰风暴",
      "Minor Heal": "小治疗",
      "Casts minor heal on yourself": "对自己施放小治疗术",
      "Heal": "治疗",
      "Casts heal on yourself": "对自己施放治疗术",
      "Quick Aid": "快速援助",
      "Rejuvenate": "恢复活力",
      "Heals all allies": "治疗所有队友",
      "Taunt": "嘲讽",
      "Greatly increases threat rating": "大幅增加威胁等级",
      "Provoke": "挑衅",
      "Tremendously increases threat rating": "极大地增加威胁等级",
      "Toughness": "坚韧",
      "Elusiveness": "闪避",
      "Greatly increases evasion temporarily": "临时大幅增加闪避",
      "Precision": "精确",
      "Greatly increases accuracy temporarily": "临时大幅增加准确性",
      "Berserk": "狂暴",
      "Frenzy": "狂躁",
      "Greatly increases attack speed temporarily": "临时大幅增加攻击速度",
      "Elemental Affinity": "元素亲和",
      "Spike Shell": "尖刺壳",
      "Gains physical reflect power temporarily": "临时获得物理反射能力",
      "Vampirism": "吸血",
      "Gains lifesteal temporarily": "临时获得生命偷取",
      "Revive": "复活",
      "Revives a dead ally": "复活一个死亡的队友",
      "Insanity": "疯狂",
      "Invincible": "坚毅",
      "Fierce Aura": "物理光环",
      "Aqua Aura": "流水光环",
      "Sylvan Aura": "自然光环",
      "Flame Aura": "火焰光环",
      "Speed Aura": "速度光环",
      "Critical Aura": "暴击光环",
      "Increases critical rate for all allies": "增加所有队友的暴击率",
      "Gobo Stabber": "哥布林长剑",
      "Gobo Slasher": "哥布林关刀",
      "Gobo Smasher": "哥布林狼牙棒",
      "Spiked Bulwark": "尖刺盾",
      "Werewolf Slasher": "狼人关刀",
      "Gobo Shooter": "哥布林弹弓",
      "Vampiric Bow": "吸血弓",
      "Gobo Boomstick": "哥布林火枪",
      "Cheese Bulwark": "奶酪盾",
      "Verdant Bulwark": "翠绿盾",
      "Azure Bulwark": "蔚蓝盾",
      "Burble Bulwark": "深紫盾",
      "Crimson Bulwark": "深红盾",
      "Rainbow Bulwark": "彩虹盾",
      "Holy Bulwark": "神圣盾",
      "Wooden Bow": "木弓",
      "Birch Bow": "桦木弓",
      "Cedar Bow": "雪松弓",
      "Purpleheart Bow": "紫心弓",
      "Ginkgo Bow": "银杏弓",
      "Redwood Bow": "红木弓",
      "Arcane Bow": "神秘弓",
      "Stalactite Spear": "钟乳石长矛",
      "Granite Bludgeon": "花岗岩大棒",
      "Soul Hunter Crossbow": "灵魂猎手弩",
      "Frost Staff": "冰霜法杖",
      "Infernal Battlestaff": "炼狱法杖",
      "Cheese Sword": "奶酪剑",
      "Verdant Sword": "翠绿剑",
      "Azure Sword": "蔚蓝剑",
      "Burble Sword": "深紫剑",
      "Crimson Sword": "深红剑",
      "Rainbow Sword": "彩虹剑",
      "Holy Sword": "神圣剑",
      "Cheese Spear": "奶酪矛",
      "Verdant Spear": "翠绿矛",
      "Azure Spear": "蔚蓝矛",
      "Burble Spear": "深紫矛",
      "Crimson Spear": "深红矛",
      "Rainbow Spear": "彩虹矛",
      "Holy Spear": "神圣矛",
      "Cheese Mace": "奶酪狼牙棒",
      "Verdant Mace": "翠绿狼牙棒",
      "Azure Mace": "蔚蓝狼牙棒",
      "Burble Mace": "深紫狼牙棒",
      "Crimson Mace": "深红狼牙棒",
      "Rainbow Mace": "彩虹狼牙棒",
      "Holy Mace": "神圣狼牙棒",
      "Wooden Crossbow": "木弩",
      "Birch Crossbow": "桦木弩",
      "Cedar Crossbow": "雪松弩",
      "Purpleheart Crossbow": "紫心木弩",
      "Ginkgo Crossbow": "银杏弩",
      "Redwood Crossbow": "红木弩",
      "Arcane Crossbow": "神秘弩",
      "Wooden Water Staff": "木水法杖",
      "Birch Water Staff": "桦木水法杖",
      "Cedar Water Staff": "雪松水法杖",
      "Purpleheart Water Staff": "紫心木水法杖",
      "Ginkgo Water Staff": "银杏水法杖",
      "Redwood Water Staff": "红木水法杖",
      "Arcane Water Staff": "神秘水法杖",
      "Wooden Nature Staff": "木自然法杖",
      "Birch Nature Staff": "桦木自然法杖",
      "Cedar Nature Staff": "雪松自然法杖",
      "Purpleheart Nature Staff": "紫心木自然法杖",
      "Ginkgo Nature Staff": "银杏自然法杖",
      "Redwood Nature Staff": "红木自然法杖",
      "Arcane Nature Staff": "神秘自然法杖",
      "Wooden Fire Staff": "木火法杖",
      "Birch Fire Staff": "桦木火法杖",
      "Cedar Fire Staff": "雪松火法杖",
      "Purpleheart Fire Staff": "紫心木火法杖",
      "Ginkgo Fire Staff": "银杏火法杖",
      "Redwood Fire Staff": "红木火法杖",
      "Arcane Fire Staff": "神秘火法杖",
      "Eye Watch": "眼睛手表",
      "Snake Fang Dirk": "蛇牙短剑",
      "Vision Shield": "视觉盾",
      "Gobo Defender": "哥布林防御者",
      "Vampire Fang Dirk": "吸血鬼短剑",
      "Treant Shield": "树人盾",
      "Tome Of Healing": "治疗之书",
      "Tome Of The Elements": "元素之书",
      "Watchful Relic": "警戒遗物",
      "Cheese Buckler": "奶酪圆盾",
      "Verdant Buckler": "翠绿圆盾",
      "Azure Buckler": "蔚蓝圆盾",
      "Burble Buckler": "深紫圆盾",
      "Crimson Buckler": "深红圆盾",
      "Rainbow Buckler": "彩虹圆盾",
      "Holy Buckler": "神圣圆盾",
      "Wooden Shield": "木盾",
      "Birch Shield": "桦木盾",
      "Cedar Shield": "雪松盾",
      "Purpleheart Shield": "紫心木盾",
      "Ginkgo Shield": "银杏盾",
      "Redwood Shield": "红木盾",
      "Arcane Shield": "神秘盾",
      "Red Chef's Hat": "红色厨师帽",
      "Snail Shell Helmet": "蜗牛壳头盔",
      "Vision Helmet": "视觉头盔",
      "Fluffy Red Hat": "蓬松红帽子",
      "Cheese Helmet": "奶酪头盔",
      "Verdant Helmet": "翠绿头盔",
      "Azure Helmet": "蔚蓝头盔",
      "Burble Helmet": "深紫头盔",
      "Crimson Helmet": "深红头盔",
      "Rainbow Helmet": "彩虹头盔",
      "Holy Helmet": "神圣头盔",
      "Rough Hood": "粗糙兜帽",
      "Reptile Hood": "爬行动物兜帽",
      "Gobo Hood": "哥布林兜帽",
      "Beast Hood": "野兽兜帽",
      "Umbral Hood": "暗影兜帽",
      "Cotton Hat": "棉帽",
      "Linen Hat": "亚麻帽",
      "Bamboo Hat": "竹帽",
      "Silk Hat": "丝帽",
      "Radiant Hat": "光辉帽",
      "Gator Vest": "鳄鱼背心",
      "Turtle Shell Body": "龟壳板甲",
      "Colossus Plate Body": "巨像板甲",
      "Demonic Plate Body": "恶魔板甲",
      "Marine Tunic": "航海束腰",
      "Revenant Tunic": "亡灵外套",
      "Icy Robe Top": "冰霜长袍",
      "Flaming Robe Top": "燃烧长袍",
      "Luna Robe Top": "月亮长袍",
      "Cheese Plate Body": "奶酪板甲",
      "Verdant Plate Body": "翠绿板甲",
      "Azure Plate Body": "蔚蓝板甲",
      "Burble Plate Body": "深紫板甲",
      "Crimson Plate Body": "深红板甲",
      "Rainbow Plate Body": "彩虹板甲",
      "Holy Plate Body": "神圣板甲",
      "Rough Tunic": "粗糙束腰",
      "Reptile Tunic": "爬行动物束腰",
      "Gobo Tunic": "哥布林束腰",
      "Beast Tunic": "野兽束腰",
      "Umbral Tunic": "暗影束腰",
      "Cotton Robe Top": "棉布上衣",
      "Linen Robe Top": "亚麻上衣",
      "Bamboo Robe Top": "竹上衣",
      "Silk Robe Top": "丝绸上衣",
      "Radiant Robe Top": "光辉上衣",
      "Turtle Shell Legs": "龟壳护腿",
      "Colossus Plate Legs": "巨像板甲护腿",
      "Demonic Plate Legs": "恶魔板甲护腿",
      "Marine Chaps": "航海护腿",
      "Revenant Chaps": "亡灵护腿",
      "Icy Robe Bottoms": "冰霜下装",
      "Flaming Robe Bottoms": "燃烧下装",
      "Luna Robe Bottoms": "月亮下装",
      "Cheese Plate Legs": "奶酪板甲护腿",
      "Verdant Plate Legs": "翠绿板甲护腿",
      "Azure Plate Legs": "蔚蓝板甲护腿",
      "Burble Plate Legs": "深紫板甲护腿",
      "Crimson Plate Legs": "深红板甲护腿",
      "Rainbow Plate Legs": "彩虹板甲护腿",
      "Holy Plate Legs": "神圣板甲护腿",
      "Rough Chaps": "粗糙护腿",
      "Reptile Chaps": "爬行动物护腿",
      "Gobo Chaps": "哥布林护腿",
      "Beast Chaps": "野兽护腿",
      "Umbral Chaps": "暗影护腿",
      "Cotton Robe Bottoms": "棉长袍下装",
      "Linen Robe Bottoms": "亚麻长袍下装",
      "Bamboo Robe Bottoms": "竹长袍下装",
      "Silk Robe Bottoms": "丝长袍下装",
      "Radiant Robe Bottoms": "光辉长袍下装",
      "Enchanted Gloves": "附魔手套",
      "Pincer Gloves": "螯钳手套",
      "Panda Gloves": "熊猫手套",
      "Magnetic Gloves": "磁力手套",
      "Sighted Bracers": "瞄准护腕",
      "Chrono Gloves": "时空手套",
      "Cheese Gauntlets": "奶酪臂铠",
      "Verdant Gauntlets": "翠绿臂铠",
      "Azure Gauntlets": "蔚蓝臂铠",
      "Burble Gauntlets": "深紫臂铠",
      "Crimson Gauntlets": "深红臂铠",
      "Rainbow Gauntlets": "彩虹臂铠",
      "Holy Gauntlets": "神圣臂铠",
      "Rough Bracers": "粗糙护腕",
      "Reptile Bracers": "爬行动物护腕",
      "Gobo Bracers": "哥布林护腕",
      "Beast Bracers": "野兽护腕",
      "Umbral Bracers": "暗影护腕",
      "Cotton Gloves": "棉手套",
      "Linen Gloves": "亚麻手套",
      "Bamboo Gloves": "竹手套",
      "Silk Gloves": "丝手套",
      "Radiant Gloves": "光辉手套",
      "Collector's Boots": "收藏家靴",
      "Shoebill Shoes": "鲸头鹳鞋",
      "Black Bear Shoes": "黑熊鞋",
      "Grizzly Bear Shoes": "灰熊鞋",
      "Polar Bear Shoes": "北极熊鞋",
      "Centaur Boots": "半人马靴",
      "Sorcerer Boots": "巫师靴",
      "Cheese Boots": "奶酪靴",
      "Verdant Boots": "翠绿靴",
      "Azure Boots": "蔚蓝靴",
      "Burble Boots": "深紫靴",
      "Crimson Boots": "深红靴",
      "Rainbow Boots": "彩虹靴",
      "Holy Boots": "神圣靴",
      "Rough Boots": "粗糙靴",
      "Reptile Boots": "爬行动物靴",
      "Gobo Boots": "哥布林靴",
      "Beast Boots": "野兽靴",
      "Umbral Boots": "暗影靴",
      "Cotton Boots": "棉靴",
      "Linen Boots": "亚麻靴",
      "Bamboo Boots": "竹靴",
      "Silk Boots": "丝靴",
      "Radiant Boots": "光辉靴",
      "Necklace Of Efficiency": "效率项链",
      "Fighter Necklace": "战士项链",
      "Ranger Necklace": "游侠项链",
      "Wizard Necklace": "巫师项链",
      "Necklace Of Wisdom": "智慧项链",
      "Earrings Of Gathering": "采集耳环",
      "Earrings Of Armor": "护甲耳环",
      "Earrings Of Regeneration": "回复耳环",
      "Earrings Of Resistance": "抗性耳环",
      "Earrings Of Rare Find": "稀有发现耳环",
      "Ring Of Gathering": "采集戒指",
      "Ring Of Armor": "护甲戒指",
      "Ring Of Regeneration": "回复戒指",
      "Ring Of Resistance": "抗性戒指",
      "Ring Of Rare Find": "稀有发现戒指",
      "Small Pouch": "小袋子",
      "Medium Pouch": "中袋子",
      "Large Pouch": "大袋子",
      "Giant Pouch": "巨大袋子",
      "Cheese Brush": "奶酪刷子",
      "Verdant Brush": "翠绿刷子",
      "Azure Brush": "蔚蓝刷子",
      "Burble Brush": "深紫刷子",
      "Crimson Brush": "深红刷子",
      "Rainbow Brush": "彩虹刷子",
      "Holy Brush": "神圣刷子",
      "Cheese Shears": "奶酪剪刀",
      "Verdant Shears": "翠绿剪刀",
      "Azure Shears": "蔚蓝剪刀",
      "Burble Shears": "深紫剪刀",
      "Crimson Shears": "深红剪刀",
      "Rainbow Shears": "彩虹剪刀",
      "Holy Shears": "神圣剪刀",
      "Cheese Hatchet": "奶酪斧头",
      "Verdant Hatchet": "翠绿斧头",
      "Azure Hatchet": "蔚蓝斧头",
      "Burble Hatchet": "深紫斧头",
      "Crimson Hatchet": "深红斧头",
      "Holy Hatchet": "神圣斧头",
      "Rainbow Hatchet": "彩虹斧头",
      "Cheese Hammer": "奶酪锤",
      "Verdant Hammer": "翠绿锤",
      "Azure Hammer": "蔚蓝锤",
      "Burble Hammer": "深紫锤",
      "Crimson Hammer": "深红锤",
      "Rainbow Hammer": "彩虹锤",
      "Holy Hammer": "神圣锤",
      "Cheese Chisel": "奶酪凿子",
      "Verdant Chisel": "翠绿凿子",
      "Azure Chisel": "蔚蓝凿子",
      "Burble Chisel": "深紫凿子",
      "Crimson Chisel": "深红凿子",
      "Rainbow Chisel": "彩虹凿子",
      "Holy Chisel": "神圣凿子",
      "Cheese Spatula": "奶酪铲子",
      "Verdant Spatula": "翠绿铲子",
      "Azure Spatula": "蔚蓝铲子",
      "Burble Spatula": "深紫铲子",
      "Crimson Spatula": "深红铲子",
      "Rainbow Spatula": "彩虹铲子",
      "Holy Spatula": "神圣铲子",
      "Cheese Needle": "奶酪针",
      "Verdant Needle": "翠绿针",
      "Azure Needle": "蔚蓝针",
      "Burble Needle": "深紫针",
      "Crimson Needle": "深红针",
      "Rainbow Needle": "彩虹针",
      "Holy Needle": "神圣针",
      "Cheese Pot": "奶酪锅",
      "Verdant Pot": "翠绿锅",
      "Azure Pot": "蔚蓝锅",
      "Burble Pot": "深紫锅",
      "Crimson Pot": "深红锅",
      "Rainbow Pot": "彩虹锅",
      "Holy Pot": "神圣锅",
      "Cheese Enhancer": "奶酪强化器",
      "Verdant Enhancer": "翠绿强化器",
      "Azure Enhancer": "蔚蓝强化器",
      "Burble Enhancer": "深紫强化器",
      "Crimson Enhancer": "赤红强化器",
      "Rainbow Enhancer": "彩虹强化器",
      "Holy Enhancer": "神圣强化器",
      "Small Meteorite Cache": "小型陨石",
      "Medium Meteorite Cache": "中型陨石",
      "Large Meteorite Cache": "大型陨石",
      "Small Artisan's Crate": "工匠的小型箱子",
      "Medium Artisan's Crate": "工匠的中型箱子",
      "Large Artisan's Crate": "工匠的大型箱子",
      "Small Treasure Chest": "小型宝箱",
      "Medium Treasure Chest": "中型宝箱",
      "Large Treasure Chest": "大型宝箱",
      "Purple's Gift": "紫色的礼物"
    });


    // MWITools 26.4.8 的 HRID → 中文物品名映射，优先级高于历史英文名映射。
    const PRIVATE_ZH_ITEM_HRIDS = Object.freeze({
            "/items/coin": "\u91d1\u5e01",
            "/items/task_token": "\u4efb\u52a1\u4ee3\u5e01",
            "/items/labyrinth_token": "\u8ff7\u5bab\u4ee3\u5e01",
            "/items/chimerical_token": "\u5947\u5e7b\u4ee3\u5e01",
            "/items/sinister_token": "\u9634\u68ee\u4ee3\u5e01",
            "/items/enchanted_token": "\u79d8\u6cd5\u4ee3\u5e01",
            "/items/pirate_token": "\u6d77\u76d7\u4ee3\u5e01",
            "/items/guild_token": "\u516c\u4f1a\u4ee3\u5e01",
            "/items/cowbell": "\u725b\u94c3",
            "/items/bag_of_10_cowbells": "\u725b\u94c3\u888b (10\u4e2a)",
            "/items/purples_gift": "\u5c0f\u7d2b\u725b\u7684\u793c\u7269",
            "/items/small_meteorite_cache": "\u5c0f\u9668\u77f3\u8231",
            "/items/medium_meteorite_cache": "\u4e2d\u9668\u77f3\u8231",
            "/items/large_meteorite_cache": "\u5927\u9668\u77f3\u8231",
            "/items/small_artisans_crate": "\u5c0f\u5de5\u5320\u5323",
            "/items/medium_artisans_crate": "\u4e2d\u5de5\u5320\u5323",
            "/items/large_artisans_crate": "\u5927\u5de5\u5320\u5323",
            "/items/small_treasure_chest": "\u5c0f\u5b9d\u7bb1",
            "/items/medium_treasure_chest": "\u4e2d\u5b9d\u7bb1",
            "/items/large_treasure_chest": "\u5927\u5b9d\u7bb1",
            "/items/chimerical_chest": "\u5947\u5e7b\u5b9d\u7bb1",
            "/items/chimerical_refinement_chest": "\u5947\u5e7b\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/sinister_chest": "\u9634\u68ee\u5b9d\u7bb1",
            "/items/sinister_refinement_chest": "\u9634\u68ee\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/enchanted_chest": "\u79d8\u6cd5\u5b9d\u7bb1",
            "/items/enchanted_refinement_chest": "\u79d8\u6cd5\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/pirate_chest": "\u6d77\u76d7\u5b9d\u7bb1",
            "/items/pirate_refinement_chest": "\u6d77\u76d7\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/purdoras_box_skilling": "\u7d2b\u591a\u62c9\u4e4b\u76d2\uff08\u751f\u6d3b\uff09",
            "/items/purdoras_box_combat": "\u7d2b\u591a\u62c9\u4e4b\u76d2\uff08\u6218\u6597\uff09",
            "/items/labyrinth_refinement_chest": "\u8ff7\u5bab\u7cbe\u70bc\u5b9d\u7bb1",
            "/items/seal_of_gathering": "\u91c7\u96c6\u5377\u8f74",
            "/items/seal_of_gourmet": "\u7f8e\u98df\u5377\u8f74",
            "/items/seal_of_processing": "\u52a0\u5de5\u5377\u8f74",
            "/items/seal_of_efficiency": "\u6548\u7387\u5377\u8f74",
            "/items/seal_of_action_speed": "\u884c\u52a8\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_combat_drop": "\u6218\u6597\u6389\u843d\u5377\u8f74",
            "/items/seal_of_attack_speed": "\u653b\u51fb\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_cast_speed": "\u65bd\u6cd5\u901f\u5ea6\u5377\u8f74",
            "/items/seal_of_damage": "\u4f24\u5bb3\u5377\u8f74",
            "/items/seal_of_critical_rate": "\u66b4\u51fb\u7387\u5377\u8f74",
            "/items/seal_of_wisdom": "\u7ecf\u9a8c\u5377\u8f74",
            "/items/seal_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u5377\u8f74",
            "/items/blue_key_fragment": "\u84dd\u8272\u94a5\u5319\u788e\u7247",
            "/items/green_key_fragment": "\u7eff\u8272\u94a5\u5319\u788e\u7247",
            "/items/purple_key_fragment": "\u7d2b\u8272\u94a5\u5319\u788e\u7247",
            "/items/white_key_fragment": "\u767d\u8272\u94a5\u5319\u788e\u7247",
            "/items/orange_key_fragment": "\u6a59\u8272\u94a5\u5319\u788e\u7247",
            "/items/brown_key_fragment": "\u68d5\u8272\u94a5\u5319\u788e\u7247",
            "/items/stone_key_fragment": "\u77f3\u5934\u94a5\u5319\u788e\u7247",
            "/items/dark_key_fragment": "\u9ed1\u6697\u94a5\u5319\u788e\u7247",
            "/items/burning_key_fragment": "\u71c3\u70e7\u94a5\u5319\u788e\u7247",
            "/items/chimerical_entry_key": "\u5947\u5e7b\u94a5\u5319",
            "/items/chimerical_chest_key": "\u5947\u5e7b\u5b9d\u7bb1\u94a5\u5319",
            "/items/sinister_entry_key": "\u9634\u68ee\u94a5\u5319",
            "/items/sinister_chest_key": "\u9634\u68ee\u5b9d\u7bb1\u94a5\u5319",
            "/items/enchanted_entry_key": "\u79d8\u6cd5\u94a5\u5319",
            "/items/enchanted_chest_key": "\u79d8\u6cd5\u5b9d\u7bb1\u94a5\u5319",
            "/items/pirate_entry_key": "\u6d77\u76d7\u94a5\u5319",
            "/items/pirate_chest_key": "\u6d77\u76d7\u5b9d\u7bb1\u94a5\u5319",
            "/items/donut": "\u751c\u751c\u5708",
            "/items/blueberry_donut": "\u84dd\u8393\u751c\u751c\u5708",
            "/items/blackberry_donut": "\u9ed1\u8393\u751c\u751c\u5708",
            "/items/strawberry_donut": "\u8349\u8393\u751c\u751c\u5708",
            "/items/mooberry_donut": "\u54de\u8393\u751c\u751c\u5708",
            "/items/marsberry_donut": "\u706b\u661f\u8393\u751c\u751c\u5708",
            "/items/spaceberry_donut": "\u592a\u7a7a\u8393\u751c\u751c\u5708",
            "/items/cupcake": "\u7eb8\u676f\u86cb\u7cd5",
            "/items/blueberry_cake": "\u84dd\u8393\u86cb\u7cd5",
            "/items/blackberry_cake": "\u9ed1\u8393\u86cb\u7cd5",
            "/items/strawberry_cake": "\u8349\u8393\u86cb\u7cd5",
            "/items/mooberry_cake": "\u54de\u8393\u86cb\u7cd5",
            "/items/marsberry_cake": "\u706b\u661f\u8393\u86cb\u7cd5",
            "/items/spaceberry_cake": "\u592a\u7a7a\u8393\u86cb\u7cd5",
            "/items/gummy": "\u8f6f\u7cd6",
            "/items/apple_gummy": "\u82f9\u679c\u8f6f\u7cd6",
            "/items/orange_gummy": "\u6a59\u5b50\u8f6f\u7cd6",
            "/items/plum_gummy": "\u674e\u5b50\u8f6f\u7cd6",
            "/items/peach_gummy": "\u6843\u5b50\u8f6f\u7cd6",
            "/items/dragon_fruit_gummy": "\u706b\u9f99\u679c\u8f6f\u7cd6",
            "/items/star_fruit_gummy": "\u6768\u6843\u8f6f\u7cd6",
            "/items/yogurt": "\u9178\u5976",
            "/items/apple_yogurt": "\u82f9\u679c\u9178\u5976",
            "/items/orange_yogurt": "\u6a59\u5b50\u9178\u5976",
            "/items/plum_yogurt": "\u674e\u5b50\u9178\u5976",
            "/items/peach_yogurt": "\u6843\u5b50\u9178\u5976",
            "/items/dragon_fruit_yogurt": "\u706b\u9f99\u679c\u9178\u5976",
            "/items/star_fruit_yogurt": "\u6768\u6843\u9178\u5976",
            "/items/milking_tea": "\u6324\u5976\u8336",
            "/items/foraging_tea": "\u91c7\u6458\u8336",
            "/items/woodcutting_tea": "\u4f10\u6728\u8336",
            "/items/cooking_tea": "\u70f9\u996a\u8336",
            "/items/brewing_tea": "\u51b2\u6ce1\u8336",
            "/items/alchemy_tea": "\u70bc\u91d1\u8336",
            "/items/enhancing_tea": "\u5f3a\u5316\u8336",
            "/items/cheesesmithing_tea": "\u5976\u916a\u953b\u9020\u8336",
            "/items/crafting_tea": "\u5236\u4f5c\u8336",
            "/items/tailoring_tea": "\u7f1d\u7eab\u8336",
            "/items/super_milking_tea": "\u8d85\u7ea7\u6324\u5976\u8336",
            "/items/super_foraging_tea": "\u8d85\u7ea7\u91c7\u6458\u8336",
            "/items/super_woodcutting_tea": "\u8d85\u7ea7\u4f10\u6728\u8336",
            "/items/super_cooking_tea": "\u8d85\u7ea7\u70f9\u996a\u8336",
            "/items/super_brewing_tea": "\u8d85\u7ea7\u51b2\u6ce1\u8336",
            "/items/super_alchemy_tea": "\u8d85\u7ea7\u70bc\u91d1\u8336",
            "/items/super_enhancing_tea": "\u8d85\u7ea7\u5f3a\u5316\u8336",
            "/items/super_cheesesmithing_tea": "\u8d85\u7ea7\u5976\u916a\u953b\u9020\u8336",
            "/items/super_crafting_tea": "\u8d85\u7ea7\u5236\u4f5c\u8336",
            "/items/super_tailoring_tea": "\u8d85\u7ea7\u7f1d\u7eab\u8336",
            "/items/ultra_milking_tea": "\u7a76\u6781\u6324\u5976\u8336",
            "/items/ultra_foraging_tea": "\u7a76\u6781\u91c7\u6458\u8336",
            "/items/ultra_woodcutting_tea": "\u7a76\u6781\u4f10\u6728\u8336",
            "/items/ultra_cooking_tea": "\u7a76\u6781\u70f9\u996a\u8336",
            "/items/ultra_brewing_tea": "\u7a76\u6781\u51b2\u6ce1\u8336",
            "/items/ultra_alchemy_tea": "\u7a76\u6781\u70bc\u91d1\u8336",
            "/items/ultra_enhancing_tea": "\u7a76\u6781\u5f3a\u5316\u8336",
            "/items/ultra_cheesesmithing_tea": "\u7a76\u6781\u5976\u916a\u953b\u9020\u8336",
            "/items/ultra_crafting_tea": "\u7a76\u6781\u5236\u4f5c\u8336",
            "/items/ultra_tailoring_tea": "\u7a76\u6781\u7f1d\u7eab\u8336",
            "/items/gathering_tea": "\u91c7\u96c6\u8336",
            "/items/gourmet_tea": "\u7f8e\u98df\u8336",
            "/items/wisdom_tea": "\u7ecf\u9a8c\u8336",
            "/items/processing_tea": "\u52a0\u5de5\u8336",
            "/items/efficiency_tea": "\u6548\u7387\u8336",
            "/items/artisan_tea": "\u5de5\u5320\u8336",
            "/items/catalytic_tea": "\u50ac\u5316\u8336",
            "/items/blessed_tea": "\u798f\u6c14\u8336",
            "/items/stamina_coffee": "\u8010\u529b\u5496\u5561",
            "/items/intelligence_coffee": "\u667a\u529b\u5496\u5561",
            "/items/defense_coffee": "\u9632\u5fa1\u5496\u5561",
            "/items/attack_coffee": "\u653b\u51fb\u5496\u5561",
            "/items/melee_coffee": "\u8fd1\u6218\u5496\u5561",
            "/items/ranged_coffee": "\u8fdc\u7a0b\u5496\u5561",
            "/items/magic_coffee": "\u9b54\u6cd5\u5496\u5561",
            "/items/super_stamina_coffee": "\u8d85\u7ea7\u8010\u529b\u5496\u5561",
            "/items/super_intelligence_coffee": "\u8d85\u7ea7\u667a\u529b\u5496\u5561",
            "/items/super_defense_coffee": "\u8d85\u7ea7\u9632\u5fa1\u5496\u5561",
            "/items/super_attack_coffee": "\u8d85\u7ea7\u653b\u51fb\u5496\u5561",
            "/items/super_melee_coffee": "\u8d85\u7ea7\u8fd1\u6218\u5496\u5561",
            "/items/super_ranged_coffee": "\u8d85\u7ea7\u8fdc\u7a0b\u5496\u5561",
            "/items/super_magic_coffee": "\u8d85\u7ea7\u9b54\u6cd5\u5496\u5561",
            "/items/ultra_stamina_coffee": "\u7a76\u6781\u8010\u529b\u5496\u5561",
            "/items/ultra_intelligence_coffee": "\u7a76\u6781\u667a\u529b\u5496\u5561",
            "/items/ultra_defense_coffee": "\u7a76\u6781\u9632\u5fa1\u5496\u5561",
            "/items/ultra_attack_coffee": "\u7a76\u6781\u653b\u51fb\u5496\u5561",
            "/items/ultra_melee_coffee": "\u7a76\u6781\u8fd1\u6218\u5496\u5561",
            "/items/ultra_ranged_coffee": "\u7a76\u6781\u8fdc\u7a0b\u5496\u5561",
            "/items/ultra_magic_coffee": "\u7a76\u6781\u9b54\u6cd5\u5496\u5561",
            "/items/wisdom_coffee": "\u7ecf\u9a8c\u5496\u5561",
            "/items/lucky_coffee": "\u5e78\u8fd0\u5496\u5561",
            "/items/swiftness_coffee": "\u8fc5\u6377\u5496\u5561",
            "/items/channeling_coffee": "\u541f\u5531\u5496\u5561",
            "/items/critical_coffee": "\u66b4\u51fb\u5496\u5561",
            "/items/poke": "\u7834\u80c6\u4e4b\u523a",
            "/items/impale": "\u900f\u9aa8\u4e4b\u523a",
            "/items/puncture": "\u7834\u7532\u4e4b\u523a",
            "/items/penetrating_strike": "\u8d2f\u5fc3\u4e4b\u523a",
            "/items/scratch": "\u722a\u5f71\u65a9",
            "/items/cleave": "\u5206\u88c2\u65a9",
            "/items/maim": "\u8840\u5203\u65a9",
            "/items/crippling_slash": "\u81f4\u6b8b\u65a9",
            "/items/smack": "\u91cd\u78be",
            "/items/sweep": "\u91cd\u626b",
            "/items/stunning_blow": "\u91cd\u9524",
            "/items/fracturing_impact": "\u788e\u88c2\u51b2\u51fb",
            "/items/shield_bash": "\u76fe\u51fb",
            "/items/quick_shot": "\u5feb\u901f\u5c04\u51fb",
            "/items/aqua_arrow": "\u6d41\u6c34\u7bad",
            "/items/flame_arrow": "\u70c8\u7130\u7bad",
            "/items/rain_of_arrows": "\u7bad\u96e8",
            "/items/silencing_shot": "\u6c89\u9ed8\u4e4b\u7bad",
            "/items/steady_shot": "\u7a33\u5b9a\u5c04\u51fb",
            "/items/pestilent_shot": "\u75ab\u75c5\u5c04\u51fb",
            "/items/penetrating_shot": "\u8d2f\u7a7f\u5c04\u51fb",
            "/items/water_strike": "\u6d41\u6c34\u51b2\u51fb",
            "/items/ice_spear": "\u51b0\u67aa\u672f",
            "/items/frost_surge": "\u51b0\u971c\u7206\u88c2",
            "/items/mana_spring": "\u6cd5\u529b\u55b7\u6cc9",
            "/items/entangle": "\u7f20\u7ed5",
            "/items/toxic_pollen": "\u5267\u6bd2\u7c89\u5c18",
            "/items/natures_veil": "\u81ea\u7136\u83cc\u5e55",
            "/items/life_drain": "\u751f\u547d\u5438\u53d6",
            "/items/fireball": "\u706b\u7403",
            "/items/flame_blast": "\u7194\u5ca9\u7206\u88c2",
            "/items/firestorm": "\u706b\u7130\u98ce\u66b4",
            "/items/smoke_burst": "\u70df\u7206\u706d\u5f71",
            "/items/minor_heal": "\u521d\u7ea7\u81ea\u6108\u672f",
            "/items/heal": "\u81ea\u6108\u672f",
            "/items/quick_aid": "\u5feb\u901f\u6cbb\u7597\u672f",
            "/items/rejuvenate": "\u7fa4\u4f53\u6cbb\u7597\u672f",
            "/items/taunt": "\u5632\u8bbd",
            "/items/provoke": "\u6311\u8845",
            "/items/toughness": "\u575a\u97e7",
            "/items/elusiveness": "\u95ea\u907f",
            "/items/precision": "\u7cbe\u786e",
            "/items/berserk": "\u72c2\u66b4",
            "/items/elemental_affinity": "\u5143\u7d20\u589e\u5e45",
            "/items/frenzy": "\u72c2\u901f",
            "/items/spike_shell": "\u5c16\u523a\u9632\u62a4",
            "/items/retribution": "\u60e9\u6212",
            "/items/vampirism": "\u5438\u8840",
            "/items/revive": "\u590d\u6d3b",
            "/items/insanity": "\u75af\u72c2",
            "/items/invincible": "\u65e0\u654c",
            "/items/speed_aura": "\u901f\u5ea6\u5149\u73af",
            "/items/guardian_aura": "\u5b88\u62a4\u5149\u73af",
            "/items/fierce_aura": "\u7269\u7406\u5149\u73af",
            "/items/critical_aura": "\u66b4\u51fb\u5149\u73af",
            "/items/mystic_aura": "\u5143\u7d20\u5149\u73af",
            "/items/gobo_stabber": "\u54e5\u5e03\u6797\u957f\u5251",
            "/items/gobo_slasher": "\u54e5\u5e03\u6797\u5173\u5200",
            "/items/gobo_smasher": "\u54e5\u5e03\u6797\u72fc\u7259\u68d2",
            "/items/spiked_bulwark": "\u5c16\u523a\u91cd\u76fe",
            "/items/werewolf_slasher": "\u72fc\u4eba\u5173\u5200",
            "/items/griffin_bulwark": "\u72ee\u9e6b\u91cd\u76fe",
            "/items/griffin_bulwark_refined": "\u72ee\u9e6b\u91cd\u76fe \u2605",
            "/items/gobo_shooter": "\u54e5\u5e03\u6797\u5f39\u5f13",
            "/items/vampiric_bow": "\u5438\u8840\u5f13",
            "/items/cursed_bow": "\u5492\u6028\u4e4b\u5f13",
            "/items/cursed_bow_refined": "\u5492\u6028\u4e4b\u5f13 \u2605",
            "/items/gobo_boomstick": "\u54e5\u5e03\u6797\u706b\u68cd",
            "/items/cheese_bulwark": "\u5976\u916a\u91cd\u76fe",
            "/items/verdant_bulwark": "\u7fe0\u7eff\u91cd\u76fe",
            "/items/azure_bulwark": "\u851a\u84dd\u91cd\u76fe",
            "/items/burble_bulwark": "\u6df1\u7d2b\u91cd\u76fe",
            "/items/crimson_bulwark": "\u7edb\u7ea2\u91cd\u76fe",
            "/items/rainbow_bulwark": "\u5f69\u8679\u91cd\u76fe",
            "/items/holy_bulwark": "\u795e\u5723\u91cd\u76fe",
            "/items/wooden_bow": "\u6728\u5f13",
            "/items/birch_bow": "\u6866\u6728\u5f13",
            "/items/cedar_bow": "\u96ea\u677e\u5f13",
            "/items/purpleheart_bow": "\u7d2b\u5fc3\u5f13",
            "/items/ginkgo_bow": "\u94f6\u674f\u5f13",
            "/items/redwood_bow": "\u7ea2\u6749\u5f13",
            "/items/arcane_bow": "\u795e\u79d8\u5f13",
            "/items/stalactite_spear": "\u77f3\u949f\u957f\u67aa",
            "/items/granite_bludgeon": "\u82b1\u5c97\u5ca9\u5927\u68d2",
            "/items/furious_spear": "\u72c2\u6012\u957f\u67aa",
            "/items/furious_spear_refined": "\u72c2\u6012\u957f\u67aa \u2605",
            "/items/regal_sword": "\u541b\u738b\u4e4b\u5251",
            "/items/regal_sword_refined": "\u541b\u738b\u4e4b\u5251 \u2605",
            "/items/chaotic_flail": "\u6df7\u6c8c\u8fde\u67b7",
            "/items/chaotic_flail_refined": "\u6df7\u6c8c\u8fde\u67b7 \u2605",
            "/items/soul_hunter_crossbow": "\u7075\u9b42\u730e\u624b\u5f29",
            "/items/sundering_crossbow": "\u88c2\u7a7a\u4e4b\u5f29",
            "/items/sundering_crossbow_refined": "\u88c2\u7a7a\u4e4b\u5f29 \u2605",
            "/items/frost_staff": "\u51b0\u971c\u6cd5\u6756",
            "/items/infernal_battlestaff": "\u70bc\u72f1\u6cd5\u6756",
            "/items/jackalope_staff": "\u9e7f\u89d2\u5154\u4e4b\u6756",
            "/items/rippling_trident": "\u6d9f\u6f2a\u4e09\u53c9\u621f",
            "/items/rippling_trident_refined": "\u6d9f\u6f2a\u4e09\u53c9\u621f \u2605",
            "/items/blooming_trident": "\u7efd\u653e\u4e09\u53c9\u621f",
            "/items/blooming_trident_refined": "\u7efd\u653e\u4e09\u53c9\u621f \u2605",
            "/items/blazing_trident": "\u70bd\u7130\u4e09\u53c9\u621f",
            "/items/blazing_trident_refined": "\u70bd\u7130\u4e09\u53c9\u621f \u2605",
            "/items/cheese_sword": "\u5976\u916a\u5251",
            "/items/verdant_sword": "\u7fe0\u7eff\u5251",
            "/items/azure_sword": "\u851a\u84dd\u5251",
            "/items/burble_sword": "\u6df1\u7d2b\u5251",
            "/items/crimson_sword": "\u7edb\u7ea2\u5251",
            "/items/rainbow_sword": "\u5f69\u8679\u5251",
            "/items/holy_sword": "\u795e\u5723\u5251",
            "/items/cheese_spear": "\u5976\u916a\u957f\u67aa",
            "/items/verdant_spear": "\u7fe0\u7eff\u957f\u67aa",
            "/items/azure_spear": "\u851a\u84dd\u957f\u67aa",
            "/items/burble_spear": "\u6df1\u7d2b\u957f\u67aa",
            "/items/crimson_spear": "\u7edb\u7ea2\u957f\u67aa",
            "/items/rainbow_spear": "\u5f69\u8679\u957f\u67aa",
            "/items/holy_spear": "\u795e\u5723\u957f\u67aa",
            "/items/cheese_mace": "\u5976\u916a\u9489\u5934\u9524",
            "/items/verdant_mace": "\u7fe0\u7eff\u9489\u5934\u9524",
            "/items/azure_mace": "\u851a\u84dd\u9489\u5934\u9524",
            "/items/burble_mace": "\u6df1\u7d2b\u9489\u5934\u9524",
            "/items/crimson_mace": "\u7edb\u7ea2\u9489\u5934\u9524",
            "/items/rainbow_mace": "\u5f69\u8679\u9489\u5934\u9524",
            "/items/holy_mace": "\u795e\u5723\u9489\u5934\u9524",
            "/items/wooden_crossbow": "\u6728\u5f29",
            "/items/birch_crossbow": "\u6866\u6728\u5f29",
            "/items/cedar_crossbow": "\u96ea\u677e\u5f29",
            "/items/purpleheart_crossbow": "\u7d2b\u5fc3\u5f29",
            "/items/ginkgo_crossbow": "\u94f6\u674f\u5f29",
            "/items/redwood_crossbow": "\u7ea2\u6749\u5f29",
            "/items/arcane_crossbow": "\u795e\u79d8\u5f29",
            "/items/wooden_water_staff": "\u6728\u5236\u6c34\u6cd5\u6756",
            "/items/birch_water_staff": "\u6866\u6728\u6c34\u6cd5\u6756",
            "/items/cedar_water_staff": "\u96ea\u677e\u6c34\u6cd5\u6756",
            "/items/purpleheart_water_staff": "\u7d2b\u5fc3\u6c34\u6cd5\u6756",
            "/items/ginkgo_water_staff": "\u94f6\u674f\u6c34\u6cd5\u6756",
            "/items/redwood_water_staff": "\u7ea2\u6749\u6c34\u6cd5\u6756",
            "/items/arcane_water_staff": "\u795e\u79d8\u6c34\u6cd5\u6756",
            "/items/wooden_nature_staff": "\u6728\u5236\u81ea\u7136\u6cd5\u6756",
            "/items/birch_nature_staff": "\u6866\u6728\u81ea\u7136\u6cd5\u6756",
            "/items/cedar_nature_staff": "\u96ea\u677e\u81ea\u7136\u6cd5\u6756",
            "/items/purpleheart_nature_staff": "\u7d2b\u5fc3\u81ea\u7136\u6cd5\u6756",
            "/items/ginkgo_nature_staff": "\u94f6\u674f\u81ea\u7136\u6cd5\u6756",
            "/items/redwood_nature_staff": "\u7ea2\u6749\u81ea\u7136\u6cd5\u6756",
            "/items/arcane_nature_staff": "\u795e\u79d8\u81ea\u7136\u6cd5\u6756",
            "/items/wooden_fire_staff": "\u6728\u5236\u706b\u6cd5\u6756",
            "/items/birch_fire_staff": "\u6866\u6728\u706b\u6cd5\u6756",
            "/items/cedar_fire_staff": "\u96ea\u677e\u706b\u6cd5\u6756",
            "/items/purpleheart_fire_staff": "\u7d2b\u5fc3\u706b\u6cd5\u6756",
            "/items/ginkgo_fire_staff": "\u94f6\u674f\u706b\u6cd5\u6756",
            "/items/redwood_fire_staff": "\u7ea2\u6749\u706b\u6cd5\u6756",
            "/items/arcane_fire_staff": "\u795e\u79d8\u706b\u6cd5\u6756",
            "/items/eye_watch": "\u638c\u4e0a\u76d1\u5de5",
            "/items/snake_fang_dirk": "\u86c7\u7259\u77ed\u5251",
            "/items/vision_shield": "\u89c6\u89c9\u76fe",
            "/items/gobo_defender": "\u54e5\u5e03\u6797\u9632\u5fa1\u8005",
            "/items/vampire_fang_dirk": "\u5438\u8840\u9b3c\u77ed\u5251",
            "/items/knights_aegis": "\u9a91\u58eb\u76fe",
            "/items/knights_aegis_refined": "\u9a91\u58eb\u76fe \u2605",
            "/items/treant_shield": "\u6811\u4eba\u76fe",
            "/items/manticore_shield": "\u874e\u72ee\u76fe",
            "/items/tome_of_healing": "\u6cbb\u7597\u4e4b\u4e66",
            "/items/tome_of_the_elements": "\u5143\u7d20\u4e4b\u4e66",
            "/items/watchful_relic": "\u8b66\u6212\u9057\u7269",
            "/items/bishops_codex": "\u4e3b\u6559\u6cd5\u5178",
            "/items/bishops_codex_refined": "\u4e3b\u6559\u6cd5\u5178 \u2605",
            "/items/cheese_buckler": "\u5976\u916a\u5706\u76fe",
            "/items/verdant_buckler": "\u7fe0\u7eff\u5706\u76fe",
            "/items/azure_buckler": "\u851a\u84dd\u5706\u76fe",
            "/items/burble_buckler": "\u6df1\u7d2b\u5706\u76fe",
            "/items/crimson_buckler": "\u7edb\u7ea2\u5706\u76fe",
            "/items/rainbow_buckler": "\u5f69\u8679\u5706\u76fe",
            "/items/holy_buckler": "\u795e\u5723\u5706\u76fe",
            "/items/wooden_shield": "\u6728\u76fe",
            "/items/birch_shield": "\u6866\u6728\u76fe",
            "/items/cedar_shield": "\u96ea\u677e\u76fe",
            "/items/purpleheart_shield": "\u7d2b\u5fc3\u76fe",
            "/items/ginkgo_shield": "\u94f6\u674f\u76fe",
            "/items/redwood_shield": "\u7ea2\u6749\u76fe",
            "/items/arcane_shield": "\u795e\u79d8\u76fe",
            "/items/gatherer_cape": "\u91c7\u96c6\u8005\u62ab\u98ce",
            "/items/gatherer_cape_refined": "\u91c7\u96c6\u8005\u62ab\u98ce \u2605",
            "/items/artificer_cape": "\u5de5\u5320\u62ab\u98ce",
            "/items/artificer_cape_refined": "\u5de5\u5320\u62ab\u98ce \u2605",
            "/items/culinary_cape": "\u53a8\u5e08\u62ab\u98ce",
            "/items/culinary_cape_refined": "\u53a8\u5e08\u62ab\u98ce \u2605",
            "/items/chance_cape": "\u673a\u7f18\u62ab\u98ce",
            "/items/chance_cape_refined": "\u673a\u7f18\u62ab\u98ce \u2605",
            "/items/sinister_cape": "\u9634\u68ee\u62ab\u98ce",
            "/items/sinister_cape_refined": "\u9634\u68ee\u62ab\u98ce \u2605",
            "/items/chimerical_quiver": "\u5947\u5e7b\u7bad\u888b",
            "/items/chimerical_quiver_refined": "\u5947\u5e7b\u7bad\u888b \u2605",
            "/items/enchanted_cloak": "\u79d8\u6cd5\u62ab\u98ce",
            "/items/enchanted_cloak_refined": "\u79d8\u6cd5\u62ab\u98ce \u2605",
            "/items/red_culinary_hat": "\u7ea2\u8272\u53a8\u5e08\u5e3d",
            "/items/snail_shell_helmet": "\u8717\u725b\u58f3\u5934\u76d4",
            "/items/vision_helmet": "\u89c6\u89c9\u5934\u76d4",
            "/items/fluffy_red_hat": "\u84ec\u677e\u7ea2\u5e3d\u5b50",
            "/items/corsair_helmet": "\u63a0\u593a\u8005\u5934\u76d4",
            "/items/corsair_helmet_refined": "\u63a0\u593a\u8005\u5934\u76d4 \u2605",
            "/items/acrobatic_hood": "\u6742\u6280\u5e08\u515c\u5e3d",
            "/items/acrobatic_hood_refined": "\u6742\u6280\u5e08\u515c\u5e3d \u2605",
            "/items/magicians_hat": "\u9b54\u672f\u5e08\u5e3d",
            "/items/magicians_hat_refined": "\u9b54\u672f\u5e08\u5e3d \u2605",
            "/items/cheese_helmet": "\u5976\u916a\u5934\u76d4",
            "/items/verdant_helmet": "\u7fe0\u7eff\u5934\u76d4",
            "/items/azure_helmet": "\u851a\u84dd\u5934\u76d4",
            "/items/burble_helmet": "\u6df1\u7d2b\u5934\u76d4",
            "/items/crimson_helmet": "\u7edb\u7ea2\u5934\u76d4",
            "/items/rainbow_helmet": "\u5f69\u8679\u5934\u76d4",
            "/items/holy_helmet": "\u795e\u5723\u5934\u76d4",
            "/items/rough_hood": "\u7c97\u7cd9\u515c\u5e3d",
            "/items/reptile_hood": "\u722c\u884c\u52a8\u7269\u515c\u5e3d",
            "/items/gobo_hood": "\u54e5\u5e03\u6797\u515c\u5e3d",
            "/items/beast_hood": "\u91ce\u517d\u515c\u5e3d",
            "/items/umbral_hood": "\u6697\u5f71\u515c\u5e3d",
            "/items/cotton_hat": "\u68c9\u5e3d",
            "/items/linen_hat": "\u4e9a\u9ebb\u5e3d",
            "/items/bamboo_hat": "\u7af9\u5e3d",
            "/items/silk_hat": "\u4e1d\u5e3d",
            "/items/radiant_hat": "\u5149\u8f89\u5e3d",
            "/items/dairyhands_top": "\u6324\u5976\u5de5\u4e0a\u8863",
            "/items/foragers_top": "\u91c7\u6458\u8005\u4e0a\u8863",
            "/items/lumberjacks_top": "\u4f10\u6728\u5de5\u4e0a\u8863",
            "/items/cheesemakers_top": "\u5976\u916a\u5e08\u4e0a\u8863",
            "/items/crafters_top": "\u5de5\u5320\u4e0a\u8863",
            "/items/tailors_top": "\u88c1\u7f1d\u4e0a\u8863",
            "/items/chefs_top": "\u53a8\u5e08\u4e0a\u8863",
            "/items/brewers_top": "\u996e\u54c1\u5e08\u4e0a\u8863",
            "/items/alchemists_top": "\u70bc\u91d1\u5e08\u4e0a\u8863",
            "/items/enhancers_top": "\u5f3a\u5316\u5e08\u4e0a\u8863",
            "/items/gator_vest": "\u9cc4\u9c7c\u9a6c\u7532",
            "/items/turtle_shell_body": "\u9f9f\u58f3\u80f8\u7532",
            "/items/colossus_plate_body": "\u5de8\u50cf\u80f8\u7532",
            "/items/demonic_plate_body": "\u6076\u9b54\u80f8\u7532",
            "/items/anchorbound_plate_body": "\u951a\u5b9a\u80f8\u7532",
            "/items/anchorbound_plate_body_refined": "\u951a\u5b9a\u80f8\u7532 \u2605",
            "/items/maelstrom_plate_body": "\u6012\u6d9b\u80f8\u7532",
            "/items/maelstrom_plate_body_refined": "\u6012\u6d9b\u80f8\u7532 \u2605",
            "/items/marine_tunic": "\u6d77\u6d0b\u76ae\u8863",
            "/items/revenant_tunic": "\u4ea1\u7075\u76ae\u8863",
            "/items/griffin_tunic": "\u72ee\u9e6b\u76ae\u8863",
            "/items/kraken_tunic": "\u514b\u62c9\u80af\u76ae\u8863",
            "/items/kraken_tunic_refined": "\u514b\u62c9\u80af\u76ae\u8863 \u2605",
            "/items/icy_robe_top": "\u51b0\u971c\u888d\u670d",
            "/items/flaming_robe_top": "\u70c8\u7130\u888d\u670d",
            "/items/luna_robe_top": "\u6708\u795e\u888d\u670d",
            "/items/royal_water_robe_top": "\u7687\u5bb6\u6c34\u7cfb\u888d\u670d",
            "/items/royal_water_robe_top_refined": "\u7687\u5bb6\u6c34\u7cfb\u888d\u670d \u2605",
            "/items/royal_nature_robe_top": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u670d",
            "/items/royal_nature_robe_top_refined": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u670d \u2605",
            "/items/royal_fire_robe_top": "\u7687\u5bb6\u706b\u7cfb\u888d\u670d",
            "/items/royal_fire_robe_top_refined": "\u7687\u5bb6\u706b\u7cfb\u888d\u670d \u2605",
            "/items/cheese_plate_body": "\u5976\u916a\u80f8\u7532",
            "/items/verdant_plate_body": "\u7fe0\u7eff\u80f8\u7532",
            "/items/azure_plate_body": "\u851a\u84dd\u80f8\u7532",
            "/items/burble_plate_body": "\u6df1\u7d2b\u80f8\u7532",
            "/items/crimson_plate_body": "\u7edb\u7ea2\u80f8\u7532",
            "/items/rainbow_plate_body": "\u5f69\u8679\u80f8\u7532",
            "/items/holy_plate_body": "\u795e\u5723\u80f8\u7532",
            "/items/rough_tunic": "\u7c97\u7cd9\u76ae\u8863",
            "/items/reptile_tunic": "\u722c\u884c\u52a8\u7269\u76ae\u8863",
            "/items/gobo_tunic": "\u54e5\u5e03\u6797\u76ae\u8863",
            "/items/beast_tunic": "\u91ce\u517d\u76ae\u8863",
            "/items/umbral_tunic": "\u6697\u5f71\u76ae\u8863",
            "/items/cotton_robe_top": "\u68c9\u888d\u670d",
            "/items/linen_robe_top": "\u4e9a\u9ebb\u888d\u670d",
            "/items/bamboo_robe_top": "\u7af9\u888d\u670d",
            "/items/silk_robe_top": "\u4e1d\u7ef8\u888d\u670d",
            "/items/radiant_robe_top": "\u5149\u8f89\u888d\u670d",
            "/items/dairyhands_bottoms": "\u6324\u5976\u5de5\u4e0b\u88c5",
            "/items/foragers_bottoms": "\u91c7\u6458\u8005\u4e0b\u88c5",
            "/items/lumberjacks_bottoms": "\u4f10\u6728\u5de5\u4e0b\u88c5",
            "/items/cheesemakers_bottoms": "\u5976\u916a\u5e08\u4e0b\u88c5",
            "/items/crafters_bottoms": "\u5de5\u5320\u4e0b\u88c5",
            "/items/tailors_bottoms": "\u88c1\u7f1d\u4e0b\u88c5",
            "/items/chefs_bottoms": "\u53a8\u5e08\u4e0b\u88c5",
            "/items/brewers_bottoms": "\u996e\u54c1\u5e08\u4e0b\u88c5",
            "/items/alchemists_bottoms": "\u70bc\u91d1\u5e08\u4e0b\u88c5",
            "/items/enhancers_bottoms": "\u5f3a\u5316\u5e08\u4e0b\u88c5",
            "/items/turtle_shell_legs": "\u9f9f\u58f3\u817f\u7532",
            "/items/colossus_plate_legs": "\u5de8\u50cf\u817f\u7532",
            "/items/demonic_plate_legs": "\u6076\u9b54\u817f\u7532",
            "/items/anchorbound_plate_legs": "\u951a\u5b9a\u817f\u7532",
            "/items/anchorbound_plate_legs_refined": "\u951a\u5b9a\u817f\u7532 \u2605",
            "/items/maelstrom_plate_legs": "\u6012\u6d9b\u817f\u7532",
            "/items/maelstrom_plate_legs_refined": "\u6012\u6d9b\u817f\u7532 \u2605",
            "/items/marine_chaps": "\u822a\u6d77\u76ae\u88e4",
            "/items/revenant_chaps": "\u4ea1\u7075\u76ae\u88e4",
            "/items/griffin_chaps": "\u72ee\u9e6b\u76ae\u88e4",
            "/items/kraken_chaps": "\u514b\u62c9\u80af\u76ae\u88e4",
            "/items/kraken_chaps_refined": "\u514b\u62c9\u80af\u76ae\u88e4 \u2605",
            "/items/icy_robe_bottoms": "\u51b0\u971c\u888d\u88d9",
            "/items/flaming_robe_bottoms": "\u70c8\u7130\u888d\u88d9",
            "/items/luna_robe_bottoms": "\u6708\u795e\u888d\u88d9",
            "/items/royal_water_robe_bottoms": "\u7687\u5bb6\u6c34\u7cfb\u888d\u88d9",
            "/items/royal_water_robe_bottoms_refined": "\u7687\u5bb6\u6c34\u7cfb\u888d\u88d9 \u2605",
            "/items/royal_nature_robe_bottoms": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u88d9",
            "/items/royal_nature_robe_bottoms_refined": "\u7687\u5bb6\u81ea\u7136\u7cfb\u888d\u88d9 \u2605",
            "/items/royal_fire_robe_bottoms": "\u7687\u5bb6\u706b\u7cfb\u888d\u88d9",
            "/items/royal_fire_robe_bottoms_refined": "\u7687\u5bb6\u706b\u7cfb\u888d\u88d9 \u2605",
            "/items/cheese_plate_legs": "\u5976\u916a\u817f\u7532",
            "/items/verdant_plate_legs": "\u7fe0\u7eff\u817f\u7532",
            "/items/azure_plate_legs": "\u851a\u84dd\u817f\u7532",
            "/items/burble_plate_legs": "\u6df1\u7d2b\u817f\u7532",
            "/items/crimson_plate_legs": "\u7edb\u7ea2\u817f\u7532",
            "/items/rainbow_plate_legs": "\u5f69\u8679\u817f\u7532",
            "/items/holy_plate_legs": "\u795e\u5723\u817f\u7532",
            "/items/rough_chaps": "\u7c97\u7cd9\u76ae\u88e4",
            "/items/reptile_chaps": "\u722c\u884c\u52a8\u7269\u76ae\u88e4",
            "/items/gobo_chaps": "\u54e5\u5e03\u6797\u76ae\u88e4",
            "/items/beast_chaps": "\u91ce\u517d\u76ae\u88e4",
            "/items/umbral_chaps": "\u6697\u5f71\u76ae\u88e4",
            "/items/cotton_robe_bottoms": "\u68c9\u888d\u88d9",
            "/items/linen_robe_bottoms": "\u4e9a\u9ebb\u888d\u88d9",
            "/items/bamboo_robe_bottoms": "\u7af9\u888d\u88d9",
            "/items/silk_robe_bottoms": "\u4e1d\u7ef8\u888d\u88d9",
            "/items/radiant_robe_bottoms": "\u5149\u8f89\u888d\u88d9",
            "/items/enchanted_gloves": "\u9644\u9b54\u624b\u5957",
            "/items/pincer_gloves": "\u87f9\u94b3\u624b\u5957",
            "/items/panda_gloves": "\u718a\u732b\u624b\u5957",
            "/items/magnetic_gloves": "\u78c1\u529b\u624b\u5957",
            "/items/dodocamel_gauntlets": "\u6e21\u6e21\u9a7c\u62a4\u624b",
            "/items/dodocamel_gauntlets_refined": "\u6e21\u6e21\u9a7c\u62a4\u624b \u2605",
            "/items/sighted_bracers": "\u7784\u51c6\u62a4\u8155",
            "/items/marksman_bracers": "\u795e\u5c04\u62a4\u8155",
            "/items/marksman_bracers_refined": "\u795e\u5c04\u62a4\u8155 \u2605",
            "/items/chrono_gloves": "\u65f6\u7a7a\u624b\u5957",
            "/items/cheese_gauntlets": "\u5976\u916a\u62a4\u624b",
            "/items/verdant_gauntlets": "\u7fe0\u7eff\u62a4\u624b",
            "/items/azure_gauntlets": "\u851a\u84dd\u62a4\u624b",
            "/items/burble_gauntlets": "\u6df1\u7d2b\u62a4\u624b",
            "/items/crimson_gauntlets": "\u7edb\u7ea2\u62a4\u624b",
            "/items/rainbow_gauntlets": "\u5f69\u8679\u62a4\u624b",
            "/items/holy_gauntlets": "\u795e\u5723\u62a4\u624b",
            "/items/rough_bracers": "\u7c97\u7cd9\u62a4\u8155",
            "/items/reptile_bracers": "\u722c\u884c\u52a8\u7269\u62a4\u8155",
            "/items/gobo_bracers": "\u54e5\u5e03\u6797\u62a4\u8155",
            "/items/beast_bracers": "\u91ce\u517d\u62a4\u8155",
            "/items/umbral_bracers": "\u6697\u5f71\u62a4\u8155",
            "/items/cotton_gloves": "\u68c9\u624b\u5957",
            "/items/linen_gloves": "\u4e9a\u9ebb\u624b\u5957",
            "/items/bamboo_gloves": "\u7af9\u624b\u5957",
            "/items/silk_gloves": "\u4e1d\u624b\u5957",
            "/items/radiant_gloves": "\u5149\u8f89\u624b\u5957",
            "/items/collectors_boots": "\u6536\u85cf\u5bb6\u9774",
            "/items/shoebill_shoes": "\u9cb8\u5934\u9e73\u978b",
            "/items/black_bear_shoes": "\u9ed1\u718a\u978b",
            "/items/grizzly_bear_shoes": "\u68d5\u718a\u978b",
            "/items/polar_bear_shoes": "\u5317\u6781\u718a\u978b",
            "/items/pathbreaker_boots": "\u5f00\u8def\u8005\u9774",
            "/items/pathbreaker_boots_refined": "\u5f00\u8def\u8005\u9774 \u2605",
            "/items/centaur_boots": "\u534a\u4eba\u9a6c\u9774",
            "/items/pathfinder_boots": "\u63a2\u8def\u8005\u9774",
            "/items/pathfinder_boots_refined": "\u63a2\u8def\u8005\u9774 \u2605",
            "/items/sorcerer_boots": "\u5deb\u5e08\u9774",
            "/items/pathseeker_boots": "\u5bfb\u8def\u8005\u9774",
            "/items/pathseeker_boots_refined": "\u5bfb\u8def\u8005\u9774 \u2605",
            "/items/cheese_boots": "\u5976\u916a\u9774",
            "/items/verdant_boots": "\u7fe0\u7eff\u9774",
            "/items/azure_boots": "\u851a\u84dd\u9774",
            "/items/burble_boots": "\u6df1\u7d2b\u9774",
            "/items/crimson_boots": "\u7edb\u7ea2\u9774",
            "/items/rainbow_boots": "\u5f69\u8679\u9774",
            "/items/holy_boots": "\u795e\u5723\u9774",
            "/items/rough_boots": "\u7c97\u7cd9\u9774",
            "/items/reptile_boots": "\u722c\u884c\u52a8\u7269\u9774",
            "/items/gobo_boots": "\u54e5\u5e03\u6797\u9774",
            "/items/beast_boots": "\u91ce\u517d\u9774",
            "/items/umbral_boots": "\u6697\u5f71\u9774",
            "/items/cotton_boots": "\u68c9\u9774",
            "/items/linen_boots": "\u4e9a\u9ebb\u9774",
            "/items/bamboo_boots": "\u7af9\u9774",
            "/items/silk_boots": "\u4e1d\u9774",
            "/items/radiant_boots": "\u5149\u8f89\u9774",
            "/items/small_pouch": "\u5c0f\u888b\u5b50",
            "/items/medium_pouch": "\u4e2d\u888b\u5b50",
            "/items/large_pouch": "\u5927\u888b\u5b50",
            "/items/giant_pouch": "\u5de8\u5927\u888b\u5b50",
            "/items/gluttonous_pouch": "\u8d2a\u98df\u4e4b\u888b",
            "/items/guzzling_pouch": "\u66b4\u996e\u4e4b\u56ca",
            "/items/necklace_of_efficiency": "\u6548\u7387\u9879\u94fe",
            "/items/fighter_necklace": "\u6218\u58eb\u9879\u94fe",
            "/items/ranger_necklace": "\u5c04\u624b\u9879\u94fe",
            "/items/wizard_necklace": "\u5deb\u5e08\u9879\u94fe",
            "/items/necklace_of_wisdom": "\u7ecf\u9a8c\u9879\u94fe",
            "/items/necklace_of_speed": "\u901f\u5ea6\u9879\u94fe",
            "/items/philosophers_necklace": "\u8d24\u8005\u9879\u94fe",
            "/items/earrings_of_gathering": "\u91c7\u96c6\u8033\u73af",
            "/items/earrings_of_essence_find": "\u7cbe\u534e\u53d1\u73b0\u8033\u73af",
            "/items/earrings_of_armor": "\u62a4\u7532\u8033\u73af",
            "/items/earrings_of_regeneration": "\u6062\u590d\u8033\u73af",
            "/items/earrings_of_resistance": "\u6297\u6027\u8033\u73af",
            "/items/earrings_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u8033\u73af",
            "/items/earrings_of_critical_strike": "\u66b4\u51fb\u8033\u73af",
            "/items/philosophers_earrings": "\u8d24\u8005\u8033\u73af",
            "/items/ring_of_gathering": "\u91c7\u96c6\u6212\u6307",
            "/items/ring_of_essence_find": "\u7cbe\u534e\u53d1\u73b0\u6212\u6307",
            "/items/ring_of_armor": "\u62a4\u7532\u6212\u6307",
            "/items/ring_of_regeneration": "\u6062\u590d\u6212\u6307",
            "/items/ring_of_resistance": "\u6297\u6027\u6212\u6307",
            "/items/ring_of_rare_find": "\u7a00\u6709\u53d1\u73b0\u6212\u6307",
            "/items/ring_of_critical_strike": "\u66b4\u51fb\u6212\u6307",
            "/items/philosophers_ring": "\u8d24\u8005\u6212\u6307",
            "/items/trainee_milking_charm": "\u5b9e\u4e60\u6324\u5976\u62a4\u7b26",
            "/items/basic_milking_charm": "\u57fa\u7840\u6324\u5976\u62a4\u7b26",
            "/items/advanced_milking_charm": "\u9ad8\u7ea7\u6324\u5976\u62a4\u7b26",
            "/items/expert_milking_charm": "\u4e13\u5bb6\u6324\u5976\u62a4\u7b26",
            "/items/master_milking_charm": "\u5927\u5e08\u6324\u5976\u62a4\u7b26",
            "/items/grandmaster_milking_charm": "\u5b97\u5e08\u6324\u5976\u62a4\u7b26",
            "/items/trainee_foraging_charm": "\u5b9e\u4e60\u91c7\u6458\u62a4\u7b26",
            "/items/basic_foraging_charm": "\u57fa\u7840\u91c7\u6458\u62a4\u7b26",
            "/items/advanced_foraging_charm": "\u9ad8\u7ea7\u91c7\u6458\u62a4\u7b26",
            "/items/expert_foraging_charm": "\u4e13\u5bb6\u91c7\u6458\u62a4\u7b26",
            "/items/master_foraging_charm": "\u5927\u5e08\u91c7\u6458\u62a4\u7b26",
            "/items/grandmaster_foraging_charm": "\u5b97\u5e08\u91c7\u6458\u62a4\u7b26",
            "/items/trainee_woodcutting_charm": "\u5b9e\u4e60\u4f10\u6728\u62a4\u7b26",
            "/items/basic_woodcutting_charm": "\u57fa\u7840\u4f10\u6728\u62a4\u7b26",
            "/items/advanced_woodcutting_charm": "\u9ad8\u7ea7\u4f10\u6728\u62a4\u7b26",
            "/items/expert_woodcutting_charm": "\u4e13\u5bb6\u4f10\u6728\u62a4\u7b26",
            "/items/master_woodcutting_charm": "\u5927\u5e08\u4f10\u6728\u62a4\u7b26",
            "/items/grandmaster_woodcutting_charm": "\u5b97\u5e08\u4f10\u6728\u62a4\u7b26",
            "/items/trainee_cheesesmithing_charm": "\u5b9e\u4e60\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/basic_cheesesmithing_charm": "\u57fa\u7840\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/advanced_cheesesmithing_charm": "\u9ad8\u7ea7\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/expert_cheesesmithing_charm": "\u4e13\u5bb6\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/master_cheesesmithing_charm": "\u5927\u5e08\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/grandmaster_cheesesmithing_charm": "\u5b97\u5e08\u5976\u916a\u953b\u9020\u62a4\u7b26",
            "/items/trainee_crafting_charm": "\u5b9e\u4e60\u5236\u4f5c\u62a4\u7b26",
            "/items/basic_crafting_charm": "\u57fa\u7840\u5236\u4f5c\u62a4\u7b26",
            "/items/advanced_crafting_charm": "\u9ad8\u7ea7\u5236\u4f5c\u62a4\u7b26",
            "/items/expert_crafting_charm": "\u4e13\u5bb6\u5236\u4f5c\u62a4\u7b26",
            "/items/master_crafting_charm": "\u5927\u5e08\u5236\u4f5c\u62a4\u7b26",
            "/items/grandmaster_crafting_charm": "\u5b97\u5e08\u5236\u4f5c\u62a4\u7b26",
            "/items/trainee_tailoring_charm": "\u5b9e\u4e60\u7f1d\u7eab\u62a4\u7b26",
            "/items/basic_tailoring_charm": "\u57fa\u7840\u7f1d\u7eab\u62a4\u7b26",
            "/items/advanced_tailoring_charm": "\u9ad8\u7ea7\u7f1d\u7eab\u62a4\u7b26",
            "/items/expert_tailoring_charm": "\u4e13\u5bb6\u7f1d\u7eab\u62a4\u7b26",
            "/items/master_tailoring_charm": "\u5927\u5e08\u7f1d\u7eab\u62a4\u7b26",
            "/items/grandmaster_tailoring_charm": "\u5b97\u5e08\u7f1d\u7eab\u62a4\u7b26",
            "/items/trainee_cooking_charm": "\u5b9e\u4e60\u70f9\u996a\u62a4\u7b26",
            "/items/basic_cooking_charm": "\u57fa\u7840\u70f9\u996a\u62a4\u7b26",
            "/items/advanced_cooking_charm": "\u9ad8\u7ea7\u70f9\u996a\u62a4\u7b26",
            "/items/expert_cooking_charm": "\u4e13\u5bb6\u70f9\u996a\u62a4\u7b26",
            "/items/master_cooking_charm": "\u5927\u5e08\u70f9\u996a\u62a4\u7b26",
            "/items/grandmaster_cooking_charm": "\u5b97\u5e08\u70f9\u996a\u62a4\u7b26",
            "/items/trainee_brewing_charm": "\u5b9e\u4e60\u51b2\u6ce1\u62a4\u7b26",
            "/items/basic_brewing_charm": "\u57fa\u7840\u51b2\u6ce1\u62a4\u7b26",
            "/items/advanced_brewing_charm": "\u9ad8\u7ea7\u51b2\u6ce1\u62a4\u7b26",
            "/items/expert_brewing_charm": "\u4e13\u5bb6\u51b2\u6ce1\u62a4\u7b26",
            "/items/master_brewing_charm": "\u5927\u5e08\u51b2\u6ce1\u62a4\u7b26",
            "/items/grandmaster_brewing_charm": "\u5b97\u5e08\u51b2\u6ce1\u62a4\u7b26",
            "/items/trainee_alchemy_charm": "\u5b9e\u4e60\u70bc\u91d1\u62a4\u7b26",
            "/items/basic_alchemy_charm": "\u57fa\u7840\u70bc\u91d1\u62a4\u7b26",
            "/items/advanced_alchemy_charm": "\u9ad8\u7ea7\u70bc\u91d1\u62a4\u7b26",
            "/items/expert_alchemy_charm": "\u4e13\u5bb6\u70bc\u91d1\u62a4\u7b26",
            "/items/master_alchemy_charm": "\u5927\u5e08\u70bc\u91d1\u62a4\u7b26",
            "/items/grandmaster_alchemy_charm": "\u5b97\u5e08\u70bc\u91d1\u62a4\u7b26",
            "/items/trainee_enhancing_charm": "\u5b9e\u4e60\u5f3a\u5316\u62a4\u7b26",
            "/items/basic_enhancing_charm": "\u57fa\u7840\u5f3a\u5316\u62a4\u7b26",
            "/items/advanced_enhancing_charm": "\u9ad8\u7ea7\u5f3a\u5316\u62a4\u7b26",
            "/items/expert_enhancing_charm": "\u4e13\u5bb6\u5f3a\u5316\u62a4\u7b26",
            "/items/master_enhancing_charm": "\u5927\u5e08\u5f3a\u5316\u62a4\u7b26",
            "/items/grandmaster_enhancing_charm": "\u5b97\u5e08\u5f3a\u5316\u62a4\u7b26",
            "/items/trainee_stamina_charm": "\u5b9e\u4e60\u8010\u529b\u62a4\u7b26",
            "/items/basic_stamina_charm": "\u57fa\u7840\u8010\u529b\u62a4\u7b26",
            "/items/advanced_stamina_charm": "\u9ad8\u7ea7\u8010\u529b\u62a4\u7b26",
            "/items/expert_stamina_charm": "\u4e13\u5bb6\u8010\u529b\u62a4\u7b26",
            "/items/master_stamina_charm": "\u5927\u5e08\u8010\u529b\u62a4\u7b26",
            "/items/grandmaster_stamina_charm": "\u5b97\u5e08\u8010\u529b\u62a4\u7b26",
            "/items/trainee_intelligence_charm": "\u5b9e\u4e60\u667a\u529b\u62a4\u7b26",
            "/items/basic_intelligence_charm": "\u57fa\u7840\u667a\u529b\u62a4\u7b26",
            "/items/advanced_intelligence_charm": "\u9ad8\u7ea7\u667a\u529b\u62a4\u7b26",
            "/items/expert_intelligence_charm": "\u4e13\u5bb6\u667a\u529b\u62a4\u7b26",
            "/items/master_intelligence_charm": "\u5927\u5e08\u667a\u529b\u62a4\u7b26",
            "/items/grandmaster_intelligence_charm": "\u5b97\u5e08\u667a\u529b\u62a4\u7b26",
            "/items/trainee_attack_charm": "\u5b9e\u4e60\u653b\u51fb\u62a4\u7b26",
            "/items/basic_attack_charm": "\u57fa\u7840\u653b\u51fb\u62a4\u7b26",
            "/items/advanced_attack_charm": "\u9ad8\u7ea7\u653b\u51fb\u62a4\u7b26",
            "/items/expert_attack_charm": "\u4e13\u5bb6\u653b\u51fb\u62a4\u7b26",
            "/items/master_attack_charm": "\u5927\u5e08\u653b\u51fb\u62a4\u7b26",
            "/items/grandmaster_attack_charm": "\u5b97\u5e08\u653b\u51fb\u62a4\u7b26",
            "/items/trainee_defense_charm": "\u5b9e\u4e60\u9632\u5fa1\u62a4\u7b26",
            "/items/basic_defense_charm": "\u57fa\u7840\u9632\u5fa1\u62a4\u7b26",
            "/items/advanced_defense_charm": "\u9ad8\u7ea7\u9632\u5fa1\u62a4\u7b26",
            "/items/expert_defense_charm": "\u4e13\u5bb6\u9632\u5fa1\u62a4\u7b26",
            "/items/master_defense_charm": "\u5927\u5e08\u9632\u5fa1\u62a4\u7b26",
            "/items/grandmaster_defense_charm": "\u5b97\u5e08\u9632\u5fa1\u62a4\u7b26",
            "/items/trainee_melee_charm": "\u5b9e\u4e60\u8fd1\u6218\u62a4\u7b26",
            "/items/basic_melee_charm": "\u57fa\u7840\u8fd1\u6218\u62a4\u7b26",
            "/items/advanced_melee_charm": "\u9ad8\u7ea7\u8fd1\u6218\u62a4\u7b26",
            "/items/expert_melee_charm": "\u4e13\u5bb6\u8fd1\u6218\u62a4\u7b26",
            "/items/master_melee_charm": "\u5927\u5e08\u8fd1\u6218\u62a4\u7b26",
            "/items/grandmaster_melee_charm": "\u5b97\u5e08\u8fd1\u6218\u62a4\u7b26",
            "/items/trainee_ranged_charm": "\u5b9e\u4e60\u8fdc\u7a0b\u62a4\u7b26",
            "/items/basic_ranged_charm": "\u57fa\u7840\u8fdc\u7a0b\u62a4\u7b26",
            "/items/advanced_ranged_charm": "\u9ad8\u7ea7\u8fdc\u7a0b\u62a4\u7b26",
            "/items/expert_ranged_charm": "\u4e13\u5bb6\u8fdc\u7a0b\u62a4\u7b26",
            "/items/master_ranged_charm": "\u5927\u5e08\u8fdc\u7a0b\u62a4\u7b26",
            "/items/grandmaster_ranged_charm": "\u5b97\u5e08\u8fdc\u7a0b\u62a4\u7b26",
            "/items/trainee_magic_charm": "\u5b9e\u4e60\u9b54\u6cd5\u62a4\u7b26",
            "/items/basic_magic_charm": "\u57fa\u7840\u9b54\u6cd5\u62a4\u7b26",
            "/items/advanced_magic_charm": "\u9ad8\u7ea7\u9b54\u6cd5\u62a4\u7b26",
            "/items/expert_magic_charm": "\u4e13\u5bb6\u9b54\u6cd5\u62a4\u7b26",
            "/items/master_magic_charm": "\u5927\u5e08\u9b54\u6cd5\u62a4\u7b26",
            "/items/grandmaster_magic_charm": "\u5b97\u5e08\u9b54\u6cd5\u62a4\u7b26",
            "/items/basic_task_badge": "\u57fa\u7840\u4efb\u52a1\u5fbd\u7ae0",
            "/items/advanced_task_badge": "\u9ad8\u7ea7\u4efb\u52a1\u5fbd\u7ae0",
            "/items/expert_task_badge": "\u4e13\u5bb6\u4efb\u52a1\u5fbd\u7ae0",
            "/items/celestial_brush": "\u661f\u7a7a\u5237\u5b50",
            "/items/cheese_brush": "\u5976\u916a\u5237\u5b50",
            "/items/verdant_brush": "\u7fe0\u7eff\u5237\u5b50",
            "/items/azure_brush": "\u851a\u84dd\u5237\u5b50",
            "/items/burble_brush": "\u6df1\u7d2b\u5237\u5b50",
            "/items/crimson_brush": "\u7edb\u7ea2\u5237\u5b50",
            "/items/rainbow_brush": "\u5f69\u8679\u5237\u5b50",
            "/items/holy_brush": "\u795e\u5723\u5237\u5b50",
            "/items/celestial_shears": "\u661f\u7a7a\u526a\u5200",
            "/items/cheese_shears": "\u5976\u916a\u526a\u5200",
            "/items/verdant_shears": "\u7fe0\u7eff\u526a\u5200",
            "/items/azure_shears": "\u851a\u84dd\u526a\u5200",
            "/items/burble_shears": "\u6df1\u7d2b\u526a\u5200",
            "/items/crimson_shears": "\u7edb\u7ea2\u526a\u5200",
            "/items/rainbow_shears": "\u5f69\u8679\u526a\u5200",
            "/items/holy_shears": "\u795e\u5723\u526a\u5200",
            "/items/celestial_hatchet": "\u661f\u7a7a\u65a7\u5934",
            "/items/cheese_hatchet": "\u5976\u916a\u65a7\u5934",
            "/items/verdant_hatchet": "\u7fe0\u7eff\u65a7\u5934",
            "/items/azure_hatchet": "\u851a\u84dd\u65a7\u5934",
            "/items/burble_hatchet": "\u6df1\u7d2b\u65a7\u5934",
            "/items/crimson_hatchet": "\u7edb\u7ea2\u65a7\u5934",
            "/items/rainbow_hatchet": "\u5f69\u8679\u65a7\u5934",
            "/items/holy_hatchet": "\u795e\u5723\u65a7\u5934",
            "/items/celestial_hammer": "\u661f\u7a7a\u9524\u5b50",
            "/items/cheese_hammer": "\u5976\u916a\u9524\u5b50",
            "/items/verdant_hammer": "\u7fe0\u7eff\u9524\u5b50",
            "/items/azure_hammer": "\u851a\u84dd\u9524\u5b50",
            "/items/burble_hammer": "\u6df1\u7d2b\u9524\u5b50",
            "/items/crimson_hammer": "\u7edb\u7ea2\u9524\u5b50",
            "/items/rainbow_hammer": "\u5f69\u8679\u9524\u5b50",
            "/items/holy_hammer": "\u795e\u5723\u9524\u5b50",
            "/items/celestial_chisel": "\u661f\u7a7a\u51ff\u5b50",
            "/items/cheese_chisel": "\u5976\u916a\u51ff\u5b50",
            "/items/verdant_chisel": "\u7fe0\u7eff\u51ff\u5b50",
            "/items/azure_chisel": "\u851a\u84dd\u51ff\u5b50",
            "/items/burble_chisel": "\u6df1\u7d2b\u51ff\u5b50",
            "/items/crimson_chisel": "\u7edb\u7ea2\u51ff\u5b50",
            "/items/rainbow_chisel": "\u5f69\u8679\u51ff\u5b50",
            "/items/holy_chisel": "\u795e\u5723\u51ff\u5b50",
            "/items/celestial_needle": "\u661f\u7a7a\u9488",
            "/items/cheese_needle": "\u5976\u916a\u9488",
            "/items/verdant_needle": "\u7fe0\u7eff\u9488",
            "/items/azure_needle": "\u851a\u84dd\u9488",
            "/items/burble_needle": "\u6df1\u7d2b\u9488",
            "/items/crimson_needle": "\u7edb\u7ea2\u9488",
            "/items/rainbow_needle": "\u5f69\u8679\u9488",
            "/items/holy_needle": "\u795e\u5723\u9488",
            "/items/celestial_spatula": "\u661f\u7a7a\u9505\u94f2",
            "/items/cheese_spatula": "\u5976\u916a\u9505\u94f2",
            "/items/verdant_spatula": "\u7fe0\u7eff\u9505\u94f2",
            "/items/azure_spatula": "\u851a\u84dd\u9505\u94f2",
            "/items/burble_spatula": "\u6df1\u7d2b\u9505\u94f2",
            "/items/crimson_spatula": "\u7edb\u7ea2\u9505\u94f2",
            "/items/rainbow_spatula": "\u5f69\u8679\u9505\u94f2",
            "/items/holy_spatula": "\u795e\u5723\u9505\u94f2",
            "/items/celestial_pot": "\u661f\u7a7a\u58f6",
            "/items/cheese_pot": "\u5976\u916a\u58f6",
            "/items/verdant_pot": "\u7fe0\u7eff\u58f6",
            "/items/azure_pot": "\u851a\u84dd\u58f6",
            "/items/burble_pot": "\u6df1\u7d2b\u58f6",
            "/items/crimson_pot": "\u7edb\u7ea2\u58f6",
            "/items/rainbow_pot": "\u5f69\u8679\u58f6",
            "/items/holy_pot": "\u795e\u5723\u58f6",
            "/items/celestial_alembic": "\u661f\u7a7a\u84b8\u998f\u5668",
            "/items/cheese_alembic": "\u5976\u916a\u84b8\u998f\u5668",
            "/items/verdant_alembic": "\u7fe0\u7eff\u84b8\u998f\u5668",
            "/items/azure_alembic": "\u851a\u84dd\u84b8\u998f\u5668",
            "/items/burble_alembic": "\u6df1\u7d2b\u84b8\u998f\u5668",
            "/items/crimson_alembic": "\u7edb\u7ea2\u84b8\u998f\u5668",
            "/items/rainbow_alembic": "\u5f69\u8679\u84b8\u998f\u5668",
            "/items/holy_alembic": "\u795e\u5723\u84b8\u998f\u5668",
            "/items/celestial_enhancer": "\u661f\u7a7a\u5f3a\u5316\u5668",
            "/items/cheese_enhancer": "\u5976\u916a\u5f3a\u5316\u5668",
            "/items/verdant_enhancer": "\u7fe0\u7eff\u5f3a\u5316\u5668",
            "/items/azure_enhancer": "\u851a\u84dd\u5f3a\u5316\u5668",
            "/items/burble_enhancer": "\u6df1\u7d2b\u5f3a\u5316\u5668",
            "/items/crimson_enhancer": "\u7edb\u7ea2\u5f3a\u5316\u5668",
            "/items/rainbow_enhancer": "\u5f69\u8679\u5f3a\u5316\u5668",
            "/items/holy_enhancer": "\u795e\u5723\u5f3a\u5316\u5668",
            "/items/milk": "\u725b\u5976",
            "/items/verdant_milk": "\u7fe0\u7eff\u725b\u5976",
            "/items/azure_milk": "\u851a\u84dd\u725b\u5976",
            "/items/burble_milk": "\u6df1\u7d2b\u725b\u5976",
            "/items/crimson_milk": "\u7edb\u7ea2\u725b\u5976",
            "/items/rainbow_milk": "\u5f69\u8679\u725b\u5976",
            "/items/holy_milk": "\u795e\u5723\u725b\u5976",
            "/items/cheese": "\u5976\u916a",
            "/items/verdant_cheese": "\u7fe0\u7eff\u5976\u916a",
            "/items/azure_cheese": "\u851a\u84dd\u5976\u916a",
            "/items/burble_cheese": "\u6df1\u7d2b\u5976\u916a",
            "/items/crimson_cheese": "\u7edb\u7ea2\u5976\u916a",
            "/items/rainbow_cheese": "\u5f69\u8679\u5976\u916a",
            "/items/holy_cheese": "\u795e\u5723\u5976\u916a",
            "/items/log": "\u539f\u6728",
            "/items/birch_log": "\u767d\u6866\u539f\u6728",
            "/items/cedar_log": "\u96ea\u677e\u539f\u6728",
            "/items/purpleheart_log": "\u7d2b\u5fc3\u539f\u6728",
            "/items/ginkgo_log": "\u94f6\u674f\u539f\u6728",
            "/items/redwood_log": "\u7ea2\u6749\u539f\u6728",
            "/items/arcane_log": "\u795e\u79d8\u539f\u6728",
            "/items/lumber": "\u6728\u677f",
            "/items/birch_lumber": "\u767d\u6866\u6728\u677f",
            "/items/cedar_lumber": "\u96ea\u677e\u6728\u677f",
            "/items/purpleheart_lumber": "\u7d2b\u5fc3\u6728\u677f",
            "/items/ginkgo_lumber": "\u94f6\u674f\u6728\u677f",
            "/items/redwood_lumber": "\u7ea2\u6749\u6728\u677f",
            "/items/arcane_lumber": "\u795e\u79d8\u6728\u677f",
            "/items/rough_hide": "\u7c97\u7cd9\u517d\u76ae",
            "/items/reptile_hide": "\u722c\u884c\u52a8\u7269\u76ae",
            "/items/gobo_hide": "\u54e5\u5e03\u6797\u76ae",
            "/items/beast_hide": "\u91ce\u517d\u76ae",
            "/items/umbral_hide": "\u6697\u5f71\u76ae",
            "/items/rough_leather": "\u7c97\u7cd9\u76ae\u9769",
            "/items/reptile_leather": "\u722c\u884c\u52a8\u7269\u76ae\u9769",
            "/items/gobo_leather": "\u54e5\u5e03\u6797\u76ae\u9769",
            "/items/beast_leather": "\u91ce\u517d\u76ae\u9769",
            "/items/umbral_leather": "\u6697\u5f71\u76ae\u9769",
            "/items/cotton": "\u68c9\u82b1",
            "/items/flax": "\u4e9a\u9ebb",
            "/items/bamboo_branch": "\u7af9\u5b50",
            "/items/cocoon": "\u8695\u8327",
            "/items/radiant_fiber": "\u5149\u8f89\u7ea4\u7ef4",
            "/items/cotton_fabric": "\u68c9\u82b1\u5e03\u6599",
            "/items/linen_fabric": "\u4e9a\u9ebb\u5e03\u6599",
            "/items/bamboo_fabric": "\u7af9\u5b50\u5e03\u6599",
            "/items/silk_fabric": "\u4e1d\u7ef8",
            "/items/radiant_fabric": "\u5149\u8f89\u5e03\u6599",
            "/items/egg": "\u9e21\u86cb",
            "/items/wheat": "\u5c0f\u9ea6",
            "/items/sugar": "\u7cd6",
            "/items/blueberry": "\u84dd\u8393",
            "/items/blackberry": "\u9ed1\u8393",
            "/items/strawberry": "\u8349\u8393",
            "/items/mooberry": "\u54de\u8393",
            "/items/marsberry": "\u706b\u661f\u8393",
            "/items/spaceberry": "\u592a\u7a7a\u8393",
            "/items/apple": "\u82f9\u679c",
            "/items/orange": "\u6a59\u5b50",
            "/items/plum": "\u674e\u5b50",
            "/items/peach": "\u6843\u5b50",
            "/items/dragon_fruit": "\u706b\u9f99\u679c",
            "/items/star_fruit": "\u6768\u6843",
            "/items/arabica_coffee_bean": "\u4f4e\u7ea7\u5496\u5561\u8c46",
            "/items/robusta_coffee_bean": "\u4e2d\u7ea7\u5496\u5561\u8c46",
            "/items/liberica_coffee_bean": "\u9ad8\u7ea7\u5496\u5561\u8c46",
            "/items/excelsa_coffee_bean": "\u7279\u7ea7\u5496\u5561\u8c46",
            "/items/fieriosa_coffee_bean": "\u706b\u5c71\u5496\u5561\u8c46",
            "/items/spacia_coffee_bean": "\u592a\u7a7a\u5496\u5561\u8c46",
            "/items/green_tea_leaf": "\u7eff\u8336\u53f6",
            "/items/black_tea_leaf": "\u9ed1\u8336\u53f6",
            "/items/burble_tea_leaf": "\u7d2b\u8336\u53f6",
            "/items/moolong_tea_leaf": "\u54de\u9f99\u8336\u53f6",
            "/items/red_tea_leaf": "\u7ea2\u8336\u53f6",
            "/items/emp_tea_leaf": "\u865a\u7a7a\u8336\u53f6",
            "/items/catalyst_of_coinification": "\u70b9\u91d1\u50ac\u5316\u5242",
            "/items/catalyst_of_decomposition": "\u5206\u89e3\u50ac\u5316\u5242",
            "/items/catalyst_of_transmutation": "\u8f6c\u5316\u50ac\u5316\u5242",
            "/items/prime_catalyst": "\u81f3\u9ad8\u50ac\u5316\u5242",
            "/items/snake_fang": "\u86c7\u7259",
            "/items/shoebill_feather": "\u9cb8\u5934\u9e73\u7fbd\u6bdb",
            "/items/snail_shell": "\u8717\u725b\u58f3",
            "/items/crab_pincer": "\u87f9\u94b3",
            "/items/turtle_shell": "\u4e4c\u9f9f\u58f3",
            "/items/marine_scale": "\u6d77\u6d0b\u9cde\u7247",
            "/items/treant_bark": "\u6811\u76ae",
            "/items/centaur_hoof": "\u534a\u4eba\u9a6c\u8e44",
            "/items/luna_wing": "\u6708\u795e\u7ffc",
            "/items/gobo_rag": "\u54e5\u5e03\u6797\u62b9\u5e03",
            "/items/goggles": "\u62a4\u76ee\u955c",
            "/items/magnifying_glass": "\u653e\u5927\u955c",
            "/items/eye_of_the_watcher": "\u89c2\u5bdf\u8005\u4e4b\u773c",
            "/items/icy_cloth": "\u51b0\u971c\u7ec7\u7269",
            "/items/flaming_cloth": "\u70c8\u7130\u7ec7\u7269",
            "/items/sorcerers_sole": "\u9b54\u6cd5\u5e08\u978b\u5e95",
            "/items/chrono_sphere": "\u65f6\u7a7a\u7403",
            "/items/frost_sphere": "\u51b0\u971c\u7403",
            "/items/panda_fluff": "\u718a\u732b\u7ed2",
            "/items/black_bear_fluff": "\u9ed1\u718a\u7ed2",
            "/items/grizzly_bear_fluff": "\u68d5\u718a\u7ed2",
            "/items/polar_bear_fluff": "\u5317\u6781\u718a\u7ed2",
            "/items/red_panda_fluff": "\u5c0f\u718a\u732b\u7ed2",
            "/items/magnet": "\u78c1\u94c1",
            "/items/stalactite_shard": "\u949f\u4e73\u77f3\u788e\u7247",
            "/items/living_granite": "\u82b1\u5c97\u5ca9",
            "/items/colossus_core": "\u5de8\u50cf\u6838\u5fc3",
            "/items/vampire_fang": "\u5438\u8840\u9b3c\u4e4b\u7259",
            "/items/werewolf_claw": "\u72fc\u4eba\u4e4b\u722a",
            "/items/revenant_anima": "\u4ea1\u8005\u4e4b\u9b42",
            "/items/soul_fragment": "\u7075\u9b42\u788e\u7247",
            "/items/infernal_ember": "\u5730\u72f1\u4f59\u70ec",
            "/items/demonic_core": "\u6076\u9b54\u6838\u5fc3",
            "/items/griffin_leather": "\u72ee\u9e6b\u4e4b\u76ae",
            "/items/manticore_sting": "\u874e\u72ee\u4e4b\u523a",
            "/items/jackalope_antler": "\u9e7f\u89d2\u5154\u4e4b\u89d2",
            "/items/dodocamel_plume": "\u6e21\u6e21\u9a7c\u4e4b\u7fce",
            "/items/griffin_talon": "\u72ee\u9e6b\u4e4b\u722a",
            "/items/chimerical_refinement_shard": "\u5947\u5e7b\u7cbe\u70bc\u788e\u7247",
            "/items/acrobats_ribbon": "\u6742\u6280\u5e08\u5f69\u5e26",
            "/items/magicians_cloth": "\u9b54\u672f\u5e08\u7ec7\u7269",
            "/items/chaotic_chain": "\u6df7\u6c8c\u9501\u94fe",
            "/items/cursed_ball": "\u8bc5\u5492\u4e4b\u7403",
            "/items/sinister_refinement_shard": "\u9634\u68ee\u7cbe\u70bc\u788e\u7247",
            "/items/royal_cloth": "\u7687\u5bb6\u7ec7\u7269",
            "/items/knights_ingot": "\u9a91\u58eb\u4e4b\u952d",
            "/items/bishops_scroll": "\u4e3b\u6559\u5377\u8f74",
            "/items/regal_jewel": "\u541b\u738b\u5b9d\u77f3",
            "/items/sundering_jewel": "\u88c2\u7a7a\u5b9d\u77f3",
            "/items/enchanted_refinement_shard": "\u79d8\u6cd5\u7cbe\u70bc\u788e\u7247",
            "/items/marksman_brooch": "\u795e\u5c04\u80f8\u9488",
            "/items/corsair_crest": "\u63a0\u593a\u8005\u5fbd\u7ae0",
            "/items/damaged_anchor": "\u7834\u635f\u8239\u951a",
            "/items/maelstrom_plating": "\u6012\u6d9b\u7532\u7247",
            "/items/kraken_leather": "\u514b\u62c9\u80af\u76ae\u9769",
            "/items/kraken_fang": "\u514b\u62c9\u80af\u4e4b\u7259",
            "/items/pirate_refinement_shard": "\u6d77\u76d7\u7cbe\u70bc\u788e\u7247",
            "/items/pathbreaker_lodestone": "\u5f00\u8def\u8005\u78c1\u77f3",
            "/items/pathfinder_lodestone": "\u63a2\u8def\u8005\u78c1\u77f3",
            "/items/pathseeker_lodestone": "\u5bfb\u8def\u8005\u78c1\u77f3",
            "/items/labyrinth_refinement_shard": "\u8ff7\u5bab\u7cbe\u70bc\u788e\u7247",
            "/items/butter_of_proficiency": "\u7cbe\u901a\u4e4b\u6cb9",
            "/items/thread_of_expertise": "\u4e13\u7cbe\u4e4b\u7ebf",
            "/items/branch_of_insight": "\u6d1e\u5bdf\u4e4b\u679d",
            "/items/gluttonous_energy": "\u8d2a\u98df\u80fd\u91cf",
            "/items/guzzling_energy": "\u66b4\u996e\u80fd\u91cf",
            "/items/milking_essence": "\u6324\u5976\u7cbe\u534e",
            "/items/foraging_essence": "\u91c7\u6458\u7cbe\u534e",
            "/items/woodcutting_essence": "\u4f10\u6728\u7cbe\u534e",
            "/items/cheesesmithing_essence": "\u5976\u916a\u953b\u9020\u7cbe\u534e",
            "/items/crafting_essence": "\u5236\u4f5c\u7cbe\u534e",
            "/items/tailoring_essence": "\u7f1d\u7eab\u7cbe\u534e",
            "/items/cooking_essence": "\u70f9\u996a\u7cbe\u534e",
            "/items/brewing_essence": "\u51b2\u6ce1\u7cbe\u534e",
            "/items/alchemy_essence": "\u70bc\u91d1\u7cbe\u534e",
            "/items/enhancing_essence": "\u5f3a\u5316\u7cbe\u534e",
            "/items/swamp_essence": "\u6cbc\u6cfd\u7cbe\u534e",
            "/items/aqua_essence": "\u6d77\u6d0b\u7cbe\u534e",
            "/items/jungle_essence": "\u4e1b\u6797\u7cbe\u534e",
            "/items/gobo_essence": "\u54e5\u5e03\u6797\u7cbe\u534e",
            "/items/eyessence": "\u773c\u7cbe\u534e",
            "/items/sorcerer_essence": "\u6cd5\u5e08\u7cbe\u534e",
            "/items/bear_essence": "\u718a\u718a\u7cbe\u534e",
            "/items/golem_essence": "\u9b54\u50cf\u7cbe\u534e",
            "/items/twilight_essence": "\u66ae\u5149\u7cbe\u534e",
            "/items/abyssal_essence": "\u5730\u72f1\u7cbe\u534e",
            "/items/chimerical_essence": "\u5947\u5e7b\u7cbe\u534e",
            "/items/sinister_essence": "\u9634\u68ee\u7cbe\u534e",
            "/items/enchanted_essence": "\u79d8\u6cd5\u7cbe\u534e",
            "/items/pirate_essence": "\u6d77\u76d7\u7cbe\u534e",
            "/items/labyrinth_essence": "\u8ff7\u5bab\u7cbe\u534e",
            "/items/task_crystal": "\u4efb\u52a1\u6c34\u6676",
            "/items/star_fragment": "\u661f\u5149\u788e\u7247",
            "/items/pearl": "\u73cd\u73e0",
            "/items/amber": "\u7425\u73c0",
            "/items/garnet": "\u77f3\u69b4\u77f3",
            "/items/jade": "\u7fe1\u7fe0",
            "/items/amethyst": "\u7d2b\u6c34\u6676",
            "/items/moonstone": "\u6708\u4eae\u77f3",
            "/items/sunstone": "\u592a\u9633\u77f3",
            "/items/philosophers_stone": "\u8d24\u8005\u4e4b\u77f3",
            "/items/crushed_pearl": "\u73cd\u73e0\u788e\u7247",
            "/items/crushed_amber": "\u7425\u73c0\u788e\u7247",
            "/items/crushed_garnet": "\u77f3\u69b4\u77f3\u788e\u7247",
            "/items/crushed_jade": "\u7fe1\u7fe0\u788e\u7247",
            "/items/crushed_amethyst": "\u7d2b\u6c34\u6676\u788e\u7247",
            "/items/crushed_moonstone": "\u6708\u4eae\u77f3\u788e\u7247",
            "/items/crushed_sunstone": "\u592a\u9633\u77f3\u788e\u7247",
            "/items/crushed_philosophers_stone": "\u8d24\u8005\u4e4b\u77f3\u788e\u7247",
            "/items/shard_of_protection": "\u4fdd\u62a4\u788e\u7247",
            "/items/mirror_of_protection": "\u4fdd\u62a4\u4e4b\u955c",
            "/items/philosophers_mirror": "\u8d24\u8005\u4e4b\u955c",
            "/items/basic_torch": "\u57fa\u7840\u706b\u628a",
            "/items/advanced_torch": "\u8fdb\u9636\u706b\u628a",
            "/items/expert_torch": "\u4e13\u5bb6\u706b\u628a",
            "/items/basic_shroud": "\u57fa\u7840\u6597\u7bf7",
            "/items/advanced_shroud": "\u8fdb\u9636\u6597\u7bf7",
            "/items/expert_shroud": "\u4e13\u5bb6\u6597\u7bf7",
            "/items/basic_beacon": "\u57fa\u7840\u63a2\u7167\u706f",
            "/items/advanced_beacon": "\u8fdb\u9636\u63a2\u7167\u706f",
            "/items/expert_beacon": "\u4e13\u5bb6\u63a2\u7167\u706f",
            "/items/basic_food_crate": "\u57fa\u7840\u98df\u7269\u7bb1",
            "/items/advanced_food_crate": "\u8fdb\u9636\u98df\u7269\u7bb1",
            "/items/expert_food_crate": "\u4e13\u5bb6\u98df\u7269\u7bb1",
            "/items/basic_tea_crate": "\u57fa\u7840\u8336\u53f6\u7bb1",
            "/items/advanced_tea_crate": "\u8fdb\u9636\u8336\u53f6\u7bb1",
            "/items/expert_tea_crate": "\u4e13\u5bb6\u8336\u53f6\u7bb1",
            "/items/basic_coffee_crate": "\u57fa\u7840\u5496\u5561\u7bb1",
            "/items/advanced_coffee_crate": "\u8fdb\u9636\u5496\u5561\u7bb1",
            "/items/expert_coffee_crate": "\u4e13\u5bb6\u5496\u5561\u7bb1"
    });
    // 所有装备槽位：统一从身上找穿着的 itemHrid，再从背包+身上取同名最高强化等级
    const ALL_EQUIPMENT_SLOTS = [
      "/item_locations/head",
      "/item_locations/body",
      "/item_locations/legs",
      "/item_locations/feet",
      "/item_locations/hands",
      "/item_locations/off_hand",
      "/item_locations/back",
      "/item_locations/neck",
      "/item_locations/earrings",
      "/item_locations/ring",
      "/item_locations/pouch",
      "/item_locations/enhancing_tool",
      "/item_locations/charm"
    ];

    // ═══════════════════════════════════════════════
    //  游戏数据缓存
    // ═══════════════════════════════════════════════
    let cachedInitClientData = null;
    let cachedInitClientDataRaw = null;

    // ═══════════════════════════════════════════════
    //  基础工具
    // ═══════════════════════════════════════════════
    function getInitClientData() {
      const keys = ["initClientData", "game-game-data"];
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        if (cachedInitClientData && cachedInitClientDataRaw === raw) return cachedInitClientData;
        const lz = typeof LZString !== "undefined" ? LZString : null;
        const parsers = [
          () => JSON.parse(raw),
          () => lz?.decompressFromUTF16 ? JSON.parse(lz.decompressFromUTF16(raw)) : null,
          () => lz?.decompressFromBase64 ? JSON.parse(lz.decompressFromBase64(raw)) : null
        ];
        for (const parser of parsers) {
          try {
            const parsed = parser();
            if (parsed && typeof parsed === "object" && (parsed.itemDetailMap || parsed.actionDetailMap)) {
              cachedInitClientData = parsed;
              cachedInitClientDataRaw = raw;
              return cachedInitClientData;
            }
          } catch (_) {}
        }
      }
      return null;
    }

    function isLikelyGameState(state) {
      return Boolean(
        state && typeof state === "object" &&
        (state.characterSkillMap || state.characterItemMap || state.combatUnit || state.gameConn)
      );
    }

    function findGameStateFromFiber(rootFiber) {
      if (!rootFiber || typeof rootFiber !== "object") return null;
      const queue = [rootFiber];
      const visited = new Set();
      let steps = 0;
      while (queue.length > 0 && steps < 20000) {
        const fiber = queue.shift();
        if (!fiber || typeof fiber !== "object" || visited.has(fiber)) continue;
        visited.add(fiber);
        steps++;
        const st = fiber.stateNode?.state;
        if (isLikelyGameState(st)) return st;
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      return null;
    }

    function getGameState() {
      const gamePage = document.querySelector('[class^="GamePage"]');
      if (gamePage) {
        const reactKey = Object.keys(gamePage).find(k => k.startsWith("__reactFiber$"));
        if (reactKey) {
          const fiberNode = gamePage[reactKey];
          const directState = fiberNode?.return?.stateNode?.state || null;
          if (isLikelyGameState(directState)) return directState;
        }
      }
      const rootEl = document.getElementById("root");
      let rootContainer = rootEl?._reactRootContainer || null;
      if (!rootContainer) {
        const fallback = Array.from(document.querySelectorAll("div")).find(
          el => Object.prototype.hasOwnProperty.call(el, "_reactRootContainer")
        );
        rootContainer = fallback?._reactRootContainer || null;
      }
      return findGameStateFromFiber(rootContainer?.current || null);
    }

    function getSkillLevel(state, skillHrid) {
      const skillMap = state?.characterSkillMap;
      if (!skillMap) return 0;
      const entry = skillMap instanceof Map ? skillMap.get(skillHrid) : skillMap[skillHrid];
      return Number(entry?.level || 0);
    }

    function getItemDetail(hrid, state) {
      return state?.itemDetailDict?.[hrid]
        || getInitClientData()?.itemDetailMap?.[hrid]
        || null;
    }

    function getAllItems(state) {
      const itemMap = state?.characterItemMap;
      if (!itemMap) return [];
      return itemMap instanceof Map ? Array.from(itemMap.values()) : Object.values(itemMap);
    }

    // ═══════════════════════════════════════════════
    //  装备读取
    // ═══════════════════════════════════════════════

    // 槽位 → 装备类型映射
    const SLOT_TO_EQUIP_TYPE = {
      "/item_locations/head": "/equipment_types/head",
      "/item_locations/body": "/equipment_types/body",
      "/item_locations/legs": "/equipment_types/legs",
      "/item_locations/feet": "/equipment_types/feet",
      "/item_locations/hands": "/equipment_types/hands",
      "/item_locations/off_hand": "/equipment_types/off_hand",
      "/item_locations/back": "/equipment_types/back",
      "/item_locations/neck": "/equipment_types/neck",
      "/item_locations/earrings": "/equipment_types/earrings",
      "/item_locations/ring": "/equipment_types/ring",
      "/item_locations/pouch": "/equipment_types/pouch",
      "/item_locations/enhancing_tool": "/equipment_types/enhancing_tool",
      "/item_locations/charm": "/equipment_types/charm"
    };

    /**
     * 比较两件装备，返回更好的那一件
     * 优先级：精炼 > 普通，高强化 > 低强化，高物品等级 > 低物品等级
     * 逻辑应该还能优化，但是暂时够用
     */
    function compareBestEquipment(a, b, aDetail, bDetail) {
      // 精炼优先
      const aRefined = a.itemHrid.includes("_refined");
      const bRefined = b.itemHrid.includes("_refined");
      if (aRefined && !bRefined) return -1;
      if (!aRefined && bRefined) return 1;
      // 强化等级
      const aLevel = Math.max(0, Number(a.enhancementLevel) || 0);
      const bLevel = Math.max(0, Number(b.enhancementLevel) || 0);
      if (aLevel !== bLevel) return bLevel - aLevel;
      // 物品等级
      const aItemLevel = aDetail?.itemLevel || 0;
      const bItemLevel = bDetail?.itemLevel || 0;
      return bItemLevel - aItemLevel;
    }

    /**
     * 为指定槽位找到最好的装备（优先身上穿的，否则从背包找）
     * 返回 { item, detail, enhancementLevel }
     */
    function findBestEquipmentForSlot(slot, state) {
      const items = getAllItems(state);
      const equipType = SLOT_TO_EQUIP_TYPE[slot];
      if (!equipType) return null;

      // 找身上穿的
      const equipped = items.find(item =>
        item.itemLocationHrid === slot && Number(item.count || 0) > 0
      );

      // 找背包中该槽位能穿的所有装备（包括身上的）
      const candidates = [];
      for (const item of items) {
        if (!item?.itemHrid || Number(item.count || 0) <= 0) continue;
        const detail = getItemDetail(item.itemHrid, state);
        if (!detail?.equipmentDetail) continue;
        // 检查装备类型是否匹配该槽位
        if (detail.equipmentDetail.type !== equipType) continue;
        // 检查是否有强化相关的 noncombatStats
        const ncs = detail.equipmentDetail.noncombatStats || {};
        if (Object.keys(ncs).length === 0) continue;
        candidates.push({ item, detail, enhancementLevel: Math.max(0, Number(item.enhancementLevel) || 0) });
      }

      if (candidates.length === 0) return null;

      // 按优先级排序
      candidates.sort((a, b) => compareBestEquipment(a.item, b.item, a.detail, b.detail));
      return candidates[0];
    }

    // ═══════════════════════════════════════════════
    //  Buff 计算
    // ═══════════════════════════════════════════════

    function computeEnhancingBuffs(state) {
      const icd = getInitClientData();
      if (!icd || !state) return null;

      const enhanceMultiplier = icd.enhancementLevelTotalBonusMultiplierTable || [];
      const buffs = {};

      // 装备：每个槽位找最好的装备（优先身上穿的，否则从背包找）
      for (const slot of ALL_EQUIPMENT_SLOTS) {
        const best = findBestEquipmentForSlot(slot, state);
        if (!best) continue;

        const { detail, enhancementLevel } = best;
        const ncs = detail.equipmentDetail.noncombatStats || {};
        const nceb = detail.equipmentDetail.noncombatEnhancementBonuses || {};
        const mult = enhanceMultiplier[enhancementLevel] || 0;

        for (const [key, value] of Object.entries(ncs)) {
          const bonus = Number(value) + (Number(nceb[key] || 0) * mult);
          buffs[key] = (buffs[key] || 0) + bonus;
        }
      }

      // 社区 buff
      const communityBuffs = state.communityActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(communityBuffs)) {
        for (const buff of communityBuffs) {
          const amount = (buff.flatBoost || 0)
            + (buff.flatBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 房子 buff
      const houseBuffs = state.houseActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(houseBuffs)) {
        for (const buff of houseBuffs) {
          const amount = (buff.flatBoost || 0)
            + (buff.flatBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1)
            + (buff.ratioBoost || 0)
            + (buff.ratioBoostLevelBonus || 0) * Math.max(0, (buff.level || 1) - 1);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 成就 buff
      const achieveBuffs = state.achievementActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(achieveBuffs)) {
        for (const buff of achieveBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // MooPass buff
      const mooPassBuffs = state.mooPassActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(mooPassBuffs)) {
        for (const buff of mooPassBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 封印 buff
      const personalBuffs = state.personalActionTypeBuffsDict?.[ENHANCE_ACTION_TYPE];
      if (Array.isArray(personalBuffs)) {
        for (const buff of personalBuffs) {
          const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
          applyBuffToMap(buffs, buff.typeHrid, amount, "enhancing");
        }
      }

      // 茶 buff
      const drinkConc = buffs.drinkConcentration || 0;
      for (const teaHrid of DEFAULT_TEAS) {
        const teaDetail = getItemDetail(teaHrid, state);
        if (!teaDetail?.consumableDetail?.buffs) continue;
        for (const buff of teaDetail.consumableDetail.buffs) {
          applyTeaBuffToMap(buffs, buff, "enhancing", drinkConc);
        }
      }

      return buffs;
    }

    function applyBuffToMap(buffs, typeHrid, amount, action) {
      if (!amount || !Number.isFinite(amount)) return;
      const mapping = {
        "/buff_types/action_speed": `${action}Speed`,
        "/buff_types/efficiency": `${action}Efficiency`,
        "/buff_types/enhancing_success": `${action}Success`,
        "/buff_types/wisdom": `${action}Experience`,
        "/buff_types/blessed": `${action}Blessed`,
        "/buff_types/rare_find": `skillingRareFind`,
        "/buff_types/enhancing_essence_find": `${action}EssenceFind`,
        "/buff_types/experience": `skillingExperience`,
        "/buff_types/skilling_experience": `skillingExperience`,
        "/buff_types/enhancing_level": `${action}Level`
      };
      const key = mapping[typeHrid];
      if (key) {
        buffs[key] = (buffs[key] || 0) + amount;
      }
    }

    function applyTeaBuffToMap(buffs, buff, action, drinkConc) {
      const conc = 1 + drinkConc;
      const typeHrid = buff.typeHrid;
      if (typeHrid === `/buff_types/${action}_level`) {
        buffs[`${action}Level`] = (buffs[`${action}Level`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/action_level") {
        buffs[`${action}Level`] = (buffs[`${action}Level`] || 0) - (buff.flatBoost || 0) * conc;
      } else if (typeHrid === `/buff_types/${action}_success`) {
        buffs[`${action}Success`] = (buffs[`${action}Success`] || 0) + (buff.ratioBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/blessed") {
        buffs[`${action}Blessed`] = (buffs[`${action}Blessed`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/action_speed") {
        buffs[`${action}Speed`] = (buffs[`${action}Speed`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/wisdom") {
        buffs[`${action}Experience`] = (buffs[`${action}Experience`] || 0) + (buff.flatBoost || 0) * conc;
      } else if (typeHrid === "/buff_types/efficiency") {
        buffs[`${action}Efficiency`] = (buffs[`${action}Efficiency`] || 0) + (buff.flatBoost || 0) * conc;
      }
    }

    function getBuffOf(buffs, key) {
      return (buffs[`enhancing${key}`] || 0) + (buffs[`skilling${key}`] || 0);
    }

    // ═══════════════════════════════════════════════
    //  强化计算
    // ═══════════════════════════════════════════════

    function invertMatrix(M) {
      const n = M.length;
      const aug = M.map((row, i) => {
        const r = new Array(2 * n).fill(0);
        for (let j = 0; j < n; j++) r[j] = row[j];
        r[n + i] = 1;
        return r;
      });
      for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let row = col + 1; row < n; row++) {
          if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        const pivot = aug[col][col];
        if (Math.abs(pivot) < 1e-15) return null;
        for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
        for (let row = 0; row < n; row++) {
          if (row === col) continue;
          const factor = aug[row][col];
          for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
        }
      }
      return aug.map(row => row.slice(n));
    }

    function matVecMul(inv, vec) {
      return inv.map(row => row.reduce((s, v, j) => s + v * vec[j], 0));
    }

    function enhancelate(itemHrid, targetLevel, protectLevel, originLevel, escapeLevel, buffs, state) {
      const icd = getInitClientData();
      if (!icd) return null;
      const item = getItemDetail(itemHrid, state);
      if (!item) return null;
      const successRateTable = icd.enhancementLevelSuccessRateTable;
      if (!successRateTable || successRateTable.length === 0) return null;

      const rawLevel = getSkillLevel(state, ENHANCE_SKILL_HRID);
      const playerLevel = rawLevel + getBuffOf(buffs, "Level");
      const successBuff = getBuffOf(buffs, "Success");
      const blessedBuff = getBuffOf(buffs, "Blessed");

      function enhanceSuccessRatio() {
        const itemLevel = item.itemLevel || 0;
        const levelRatio = playerLevel >= itemLevel
          ? (playerLevel - itemLevel) * 0.0005
          : -0.5 * (1 - playerLevel / itemLevel);
        return levelRatio + successBuff;
      }
      // Buffs may otherwise push the total outgoing probability above 1.
      // Clamp before splitting a success into normal and blessed outcomes.
      function successRateEnhance(rate) {
        return Math.min(1, Math.max(0, rate * (1 + enhanceSuccessRatio())));
      }
      function levelUpRate(rate) { return Math.min(1, successRateEnhance(rate) * (1 - blessedBuff)); }
      function levelLeapRate(rate) { return successRateEnhance(rate) * blessedBuff; }
      function failRate(rate) { return Math.max(0, 1 - successRateEnhance(rate)); }

      const stMatrix = [];
      for (let i = 0; i < targetLevel; i++) stMatrix[i] = new Array(targetLevel).fill(0);
      for (let i = 0; i < targetLevel; i++) {
        if (i < targetLevel - 1) stMatrix[i][i + 1] = levelUpRate(successRateTable[i]);
        if (i < targetLevel - 2) stMatrix[i][i + 2] = levelLeapRate(successRateTable[i]);
        const failTarget = i >= protectLevel ? i - 1 : 0;
        stMatrix[i][failTarget] += failRate(successRateTable[i]);
      }

      const offset = escapeLevel + 1;
      const size = targetLevel - offset;
      if (size <= 0) return null;

      const IminusP = [];
      for (let i = 0; i < size; i++) {
        IminusP[i] = new Array(size).fill(0);
        IminusP[i][i] = 1;
        for (let j = 0; j < size; j++) IminusP[i][j] -= stMatrix[i + offset][j + offset];
      }

      const inv = invertMatrix(IminusP);
      if (!inv) return null;

      const onesVec = new Array(size).fill(1);
      const allActions = matVecMul(inv, onesVec);

      const protectVec = new Array(size).fill(0);
      for (let i = protectLevel; i < targetLevel; i++) {
        const ri = i - offset;
        if (ri >= 0 && ri < size) protectVec[ri] = failRate(successRateTable[i]);
      }
      const allProtects = matVecMul(inv, protectVec);

      const expVec = new Array(size).fill(0);
      for (let i = 0; i < targetLevel; i++) {
        const ri = i - offset;
        if (ri < 0 || ri >= size) continue;
        const sr = successRateEnhance(successRateTable[i]);
        const baseExp = 1.4 * (1 + i) * (10 + (item.itemLevel || 0));
        expVec[ri] = (sr + 0.1 * (1 - sr)) * baseExp;
      }
      const allExp = matVecMul(inv, expVec);

      const originIdx = originLevel - offset;
      if (originIdx < 0 || originIdx >= size) return null;

      const actions = allActions[originIdx];
      const protects = allProtects[originIdx];
      const exp = allExp[originIdx];
      if (!Number.isFinite(actions) || actions < 0) return null;

      const targetRate = levelLeapRate(successRateTable[targetLevel - 2])
          * (size > 1 ? inv[originIdx][size - 2] : 0)
        + levelUpRate(successRateTable[targetLevel - 1])
          * inv[originIdx][size - 1];
      const leapRate = levelLeapRate(successRateTable[targetLevel - 1])
        * inv[originIdx][size - 1];
      let escapeRate = 1 - targetRate - leapRate;
      if (Math.abs(escapeRate) < 1e-10) escapeRate = 0;

      // ─── 项目级方差 / 协方差（解析公式） ───
      // h  = N·1  (期望次数), π = N·b (期望保护), b_i = pFail_i · [i ≥ protectLevel]
      // h2 = N·(2h-1)               => Var[actions] = h2 - h²
      // c_i = b_i·(1 + 2π_{fd(i)})  , σ2 = N·c   => Var[protects] = σ2 - π²
      // d_i = π_i + b_i·h_{fd(i)}   , γ  = N·d   => Cov[a,p] = γ - h·π
      // 这里默认 escapeLevel = -1，调用方不需要 Var[I_reached] 等项
      const bArr = new Array(size).fill(0);
      for (let i = Math.max(protectLevel, offset); i < targetLevel; i++) {
        bArr[i - offset] = failRate(successRateTable[i]);
      }
      const fdIdx = new Array(size).fill(-1);
      for (let idx = 0; idx < size; idx++) {
        const level = idx + offset;
        const failLevel = level >= protectLevel ? level - 1 : 0;
        fdIdx[idx] = (failLevel >= offset && failLevel < targetLevel) ? (failLevel - offset) : -1;
      }
      const valAt = (vec, idx) => idx >= 0 ? vec[idx] : 0;

      const twoHminus1 = allActions.map(h => 2 * h - 1);
      const h2Arr = matVecMul(inv, twoHminus1);
      const cArr = new Array(size).fill(0);
      for (let i = 0; i < size; i++) cArr[i] = bArr[i] * (1 + 2 * valAt(allProtects, fdIdx[i]));
      const sigma2Arr = matVecMul(inv, cArr);
      const dArr = new Array(size).fill(0);
      for (let i = 0; i < size; i++) dArr[i] = allProtects[i] + bArr[i] * valAt(allActions, fdIdx[i]);
      const gammaArr = matVecMul(inv, dArr);

      const h0 = allActions[originIdx];
      const p0 = allProtects[originIdx];
      const varActions = Math.max(0, h2Arr[originIdx] - h0 * h0);
      const varProtects = Math.max(0, sigma2Arr[originIdx] - p0 * p0);
      const covActProt = gammaArr[originIdx] - h0 * p0;

      return {
        actions, protects, exp, targetRate, leapRate, escapeRate,
        varActions, varProtects, covActProt
      };
    }

    // ═══════════════════════════════════════════════
    //  市场价格缓存（官方API + ABwayidle兼容（考虑可能合并@AlphB） + WebSocket实时更新）
    // ═══════════════════════════════════════════════

    const MARKET_CACHE_KEY = "MWITools_marketAPI_json";
    const OWN_CACHE_KEY = "HourlyRate_marketCache";

    function getMarketApiUrl() {
      const host = location.hostname;
      if (host.includes("test.milkywayidle.com")) {
        return "https://test.milkywayidle.com/game_data/marketplace.json";
      } else if (host.includes("test.milkywayidlecn.com")) {
        return "https://test.milkywayidlecn.com/game_data/marketplace.json";
      } else if (host.includes("milkywayidlecn.com")) {
        return "https://www.milkywayidlecn.com/game_data/marketplace.json";
      }
      return "https://www.milkywayidle.com/game_data/marketplace.json";
    }

    let marketDataCache = null;
    let marketDataLoaded = false;

    async function fetchMarketApi() {
      try {
        const url = getMarketApiUrl();
        console.log("[HourlyRate] Fetching market API:", url);
        // 公开只读快照；明确不携带游戏登录 Cookie/凭据。
        // 该请求仅在脚本初始化时执行一次，不按物品循环请求。
        const resp = await fetch(url, { credentials: "omit", cache: "default" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data?.marketData) {
          marketDataCache = data.marketData;
          window.__MWI_PRIVATE_MARKET_SNAPSHOT__ = data;
          marketDataLoaded = true;
          console.log("[HourlyRate] Market API loaded, items:", Object.keys(data.marketData).length);
        }
      } catch (e) {
        console.warn("[HourlyRate] Failed to fetch market API:", e);
      }
    }

    function getMarketCache() {
      if (marketDataCache) return marketDataCache;
      try {
        const abCache = localStorage.getItem(MARKET_CACHE_KEY);
        if (abCache) {
          const parsed = JSON.parse(abCache);
          if (parsed?.marketData) return parsed.marketData;
        }
      } catch (_) {}
      try {
        const ownCache = localStorage.getItem(OWN_CACHE_KEY);
        if (ownCache) return JSON.parse(ownCache);
      } catch (_) {}
      return {};
    }

    function saveOwnMarketCache(marketData) {
      try {
        localStorage.setItem(OWN_CACHE_KEY, JSON.stringify(marketData));
      } catch (_) {}
    }

    let lastOrderBooksCache = {};

    function updateMarketCacheFromWS(marketItemOrderBooks) {
      if (!marketItemOrderBooks?.itemHrid || !marketItemOrderBooks?.orderBooks) return;
      const itemHrid = marketItemOrderBooks.itemHrid;
      const orderBooks = marketItemOrderBooks.orderBooks;

      if (!marketDataCache) marketDataCache = {};
      if (!marketDataCache[itemHrid]) marketDataCache[itemHrid] = {};

      lastOrderBooksCache[itemHrid] = orderBooks;

      for (let level = 0; level <= 20; level++) {
        const book = orderBooks[level];
        if (book) {
          const asks = book.asks || [];
          const bids = book.bids || [];
          const askPrice = asks.length > 0 ? Math.min(...asks.map(l => l.price)) : -1;
          const bidPrice = bids.length > 0 ? Math.max(...bids.map(l => l.price)) : -1;
          if (askPrice !== -1 || bidPrice !== -1) {
            marketDataCache[itemHrid][level] = { a: askPrice, b: bidPrice };
          }
        }
      }
    }

    function getOrderBookListings(itemHrid, enhanceLevel, isAskSide) {
      const books = lastOrderBooksCache[itemHrid];
      if (!books || !books[enhanceLevel]) return [];
      return isAskSide ? (books[enhanceLevel].asks || []) : (books[enhanceLevel].bids || []);
    }

    // ═══════════════════════════════════════════════
    //  工时费计算
    // ═══════════════════════════════════════════════

    const SELL_TAX_FACTOR = 0.95;

    function getShopPrice(hrid) {
      const icd = getInitClientData();
      if (!icd?.shopItemDetailMap) return 0;
      const itemKey = hrid.split("/").pop();
      const shopItem = icd.shopItemDetailMap[`/shop_items/${itemKey}`];
      if (!shopItem?.costs) return 0;
      const coinCost = shopItem.costs.find(c => c.itemHrid === "/items/coin");
      return coinCost ? (coinCost.count || 0) : 0;
    }

    function getMarketAskPrice(hrid, enhanceLevel = 0) {
      if (hrid === "/items/coin") return 1;

      const cache = getMarketCache();
      const itemCache = cache[hrid];
      let marketAsk = 0;
      if (itemCache && itemCache[enhanceLevel]) {
        const ask = itemCache[enhanceLevel].a;
        if (ask > 0) marketAsk = ask;
      }

      if (enhanceLevel === 0) {
        const shopPrice = getShopPrice(hrid);
        if (shopPrice > 0) {
          return marketAsk > 0 ? Math.min(marketAsk, shopPrice) : shopPrice;
        }
      }
      return marketAsk;
    }

    // 只取市场订单簿左一卖单，不混入商店价格；用于白板的当前市场估值。
    function getMarketListingAskPrice(hrid, enhanceLevel = 0) {
      const itemCache = getMarketCache()[hrid];
      const ask = itemCache?.[enhanceLevel]?.a;
      return Number.isFinite(ask) && ask > 0 ? ask : 0;
    }

    function getMarketBidPrice(hrid, enhanceLevel = 0) {
      const cache = getMarketCache();
      const itemCache = cache[hrid];
      if (itemCache && itemCache[enhanceLevel]) {
        const bid = itemCache[enhanceLevel].b;
        if (bid > 0) return bid;
      }
      return 0;
    }

    // ═══════════════════════════════════════════════
    //  制造成本计算（Best Crafting Plan）
    // ═══════════════════════════════════════════════

    const MANUFACTURE_ACTIONS = ["cheesesmithing", "crafting", "tailoring"];
    const MANUFACTURE_NAMES = { cheesesmithing: "锻造", crafting: "制造", tailoring: "裁缝" };
    const MAX_CRAFT_DEPTH = 7;
    const ARTISAN_TEA_HRID = "/items/artisan_tea";

    /**
     * 获取工匠茶的 artisan buff（考虑饮料浓度）
     */
    function getArtisanBuff(state, drinkConcentration = 0) {
      const teaDetail = getItemDetail(ARTISAN_TEA_HRID, state);
      if (!teaDetail?.consumableDetail?.buffs) return 0;

      for (const buff of teaDetail.consumableDetail.buffs) {
        if (buff.typeHrid === "/buff_types/artisan") {
          return (buff.flatBoost || 0) * (1 + drinkConcentration);
        }
      }
      return 0;
    }

    /**
     * 查找物品的制造配方
     * @returns { actionDetail, actionType } 或 null
     */
    function findManufactureAction(itemHrid) {
      const icd = getInitClientData();
      if (!icd?.actionDetailMap) return null;

      const itemKey = itemHrid.split("/").pop();
      for (const action of MANUFACTURE_ACTIONS) {
        const actionHrid = `/actions/${action}/${itemKey}`;
        const actionDetail = icd.actionDetailMap[actionHrid];
        if (actionDetail && actionDetail.inputItems) {
          return { actionDetail, actionType: action };
        }
      }
      return null;
    }

    /**
     * 递归计算制造成本（Best Crafting Plan，考虑工匠茶）
     * @param artisanBuff 工匠茶减少材料消耗的比例
     * @returns { cost, steps, actionType } 或 null
     */
    function calcManufactureCost(itemHrid, artisanBuff = 0, depth = 0) {
      if (depth > MAX_CRAFT_DEPTH) return null;

      // 查找制造配方
      const found = findManufactureAction(itemHrid);
      if (!found) return null;

      const { actionDetail, actionType } = found;
      let totalCost = 0;
      let maxSteps = 1;

      // 如果有 upgradeItemHrid（精炼需要的基础装备）
      if (actionDetail.upgradeItemHrid) {
        const marketPrice = getMarketAskPrice(actionDetail.upgradeItemHrid, 0);
        const sub = calcManufactureCost(actionDetail.upgradeItemHrid, artisanBuff, depth + 1);

        // 比较市场价和制造成本，选择更低的
        if (marketPrice > 0 && sub && sub.cost > 0) {
          if (sub.cost < marketPrice) {
            totalCost += sub.cost;
            maxSteps = Math.max(maxSteps, sub.steps + 1);
          } else {
            totalCost += marketPrice;
          }
        } else if (marketPrice > 0) {
          totalCost += marketPrice;
        } else if (sub && sub.cost > 0) {
          totalCost += sub.cost;
          maxSteps = Math.max(maxSteps, sub.steps + 1);
        } else {
          return null;
        }
      }

      // 计算所有输入材料的成本（应用工匠茶减少材料消耗）
      // 材料只看市场价，不递归制造
      const materialMultiplier = 1 - artisanBuff;
      for (const input of actionDetail.inputItems) {
        const count = (input.count || 1) * materialMultiplier;
        const marketPrice = getMarketAskPrice(input.itemHrid, 0);
        if (marketPrice > 0) {
          totalCost += marketPrice * count;
        } else {
          return null;
        }
      }

      return { cost: totalCost, steps: maxSteps, actionType };
    }

    /**
     * 获取白板价格（选择市场价和制造成本中更低的）
     * @param state 游戏状态（用于获取工匠茶buff）
     * @param drinkConcentration 饮料浓度
     * @returns { price, source } - source: "市场价" 或 "N步锻造/制造/裁缝"
     */
    function getWhiteItemPriceWithSource(itemHrid, state, drinkConcentration = 0) {
      const marketPrice = getMarketAskPrice(itemHrid, 0);
      const artisanBuff = getArtisanBuff(state, drinkConcentration);
      const craftResult = calcManufactureCost(itemHrid, artisanBuff, 0);

      const hasMarket = marketPrice > 0;
      const hasCraft = craftResult && craftResult.cost > 0;

      if (hasMarket && hasCraft) {
        // 两者都有，选更便宜的
        if (craftResult.cost < marketPrice) {
          const actionName = MANUFACTURE_NAMES[craftResult.actionType] || craftResult.actionType;
          return { price: craftResult.cost, source: `${craftResult.steps}步${actionName}` };
        } else {
          return { price: marketPrice, source: "市场价" };
        }
      } else if (hasMarket) {
        return { price: marketPrice, source: "市场价" };
      } else if (hasCraft) {
        const actionName = MANUFACTURE_NAMES[craftResult.actionType] || craftResult.actionType;
        return { price: craftResult.cost, source: `${craftResult.steps}步${actionName}` };
      }
      return { price: 0, source: null };
    }

    function computeEnhanceMetrics(itemHrid, targetLevel, protectLevel, originLevel, buffs, state) {
      const result = enhancelate(itemHrid, targetLevel, protectLevel, originLevel, -1, buffs, state);
      if (!result) return null;

      const icd = getInitClientData();
      const actionDetail = icd?.actionDetailMap?.[ENHANCE_ACTION_HRID];
      const baseTimeCostNs = actionDetail?.baseTimeCost || 8e9;

      const item = getItemDetail(itemHrid, state);
      const rawLevel = getSkillLevel(state, ENHANCE_SKILL_HRID);
      const playerLevel = rawLevel + getBuffOf(buffs, "Level");
      const itemLevel = item?.itemLevel || 0;

      const speedBuff = getBuffOf(buffs, "Speed");
      const speedFromLevel = Math.max(0, playerLevel - itemLevel) * 0.01;
      // Keep the time model finite if a malformed/negative buff is received.
      const totalSpeed = Math.max(0.01, 1 + speedBuff + speedFromLevel);

      const timeCostNs = baseTimeCostNs / totalSpeed;
      const effectiveTimeCostNs = Math.max(timeCostNs, MIN_TIME_COST_NS);
      const actionsPH = NS_PER_HOUR / effectiveTimeCostNs;

      const {
        actions, protects, exp, targetRate, leapRate, escapeRate,
        varActions, varProtects, covActProt
      } = result;
      const successRate = targetRate + leapRate;

      // 检查材料价格是否完整
      const enhancementCosts = item?.enhancementCosts || [];
      let matCostPerAction = 0;
      for (const mat of enhancementCosts) {
        const price = getMarketAskPrice(mat.itemHrid, 0);
        if (price <= 0) return null; // 材料价格缺失
        matCostPerAction += (mat.count || 0) * price;
      }

      // 检查白板价格（选择市场价和制造成本中更低的，制造成本考虑工匠茶）
      const drinkConcentration = buffs.drinkConcentration || 0;
      const whitePriceInfo = getWhiteItemPriceWithSource(itemHrid, state, drinkConcentration);
      if (whitePriceInfo.price <= 0) return null; // 白板价格缺失且无法制造
      const whitePrice = whitePriceInfo.price;
      const whiteSource = whitePriceInfo.source;

      // 保护材料选择：专属保护材料（或白板本体） + 保护之镜，取最便宜的
      const MIRROR_HRID = "/items/mirror_of_protection";
      const protectionCandidates = [];
      if (item?.protectionItemHrids && item.protectionItemHrids.length > 0) {
        for (const hrid of item.protectionItemHrids) {
          const price = getMarketAskPrice(hrid, 0);
          if (price > 0) protectionCandidates.push({ hrid, price });
        }
      } else {
        const selfPrice = getMarketAskPrice(itemHrid, 0);
        if (selfPrice > 0) protectionCandidates.push({ hrid: itemHrid, price: selfPrice });
      }
      const mirrorPrice = getMarketAskPrice(MIRROR_HRID, 0);
      if (mirrorPrice > 0) protectionCandidates.push({ hrid: MIRROR_HRID, price: mirrorPrice });

      // 如果需要保护但没有可用的保护材料价格，返回 null
      if (protectionCandidates.length === 0) return null;

      const bestProtection = protectionCandidates.reduce((a, b) => a.price < b.price ? a : b);
      const protectionPrice = bestProtection.price;

      // 消耗 = 材料成本 + 保护材料成本
      const consumeCost = matCostPerAction * actions + protectionPrice * protects;
      const totalCostNoHourly = consumeCost + whitePrice;

      const expBuff = getBuffOf(buffs, "Experience");
      const totalExp = exp * (1 + expBuff);
      const totalTimeHours = actions / actionsPH;
      const expPerHour = totalTimeHours > 0 ? totalExp / totalTimeHours : 0;

      return {
        actions, protects, actionsPH, successRate, escapeRate,
        totalCostNoHourly, totalTimeHours, expPerHour,
        consumeCost, whitePrice, whiteSource,
        // 风险调整所需的中间量（材料/保护单价视为确定性市场价）
        matCostPerAction, protectionPrice,
        varActions, varProtects, covActProt
      };
    }

    /**
     * 根据市场挂单价格（productPrice）计算工时费
     * 使用 enhancer 页面的简单公式：
     * hourlyCost = (productPrice * 0.95 - totalCostNoHourly) / actions * actionsPH
     */
    function calcHourlyCost(metrics, productPrice) {
      const profit = productPrice * SELL_TAX_FACTOR - metrics.totalCostNoHourly;
      return profit / metrics.actions * metrics.actionsPH;
    }

    /**
     * 风险调整工时费 = (利润/项目 - γ·Var[利润/项目]/(2W)) · 项目数/小时
     * 等价写法：= 工时费 - γ·Var[利润/小时]/(2W)
     * 只把 actions / protects 视作随机量（材料单价、保护单价、白板价、产出价均视为确定性市场价）。
     * W 为玩家流动资产，缺失或非正数则返回 null。
     */
    function calcRiskAdjustedHourlyCost(metrics, productPrice, totalAsset, riskAversion = 1) {
      if (!Number.isFinite(totalAsset) || totalAsset <= 0) return null;
      const hourly = calcHourlyCost(metrics, productPrice);
      if (!Number.isFinite(hourly)) return null;

      const cm = metrics.matCostPerAction || 0;
      const cp = metrics.protectionPrice || 0;
      const varProj = cm * cm * (metrics.varActions || 0)
        + cp * cp * (metrics.varProtects || 0)
        + 2 * cm * cp * (metrics.covActProt || 0);
      if (!Number.isFinite(varProj) || varProj < 0) return hourly;

      const projectsPerHour = metrics.actions > 0 ? metrics.actionsPH / metrics.actions : 0;
      const varHourly = varProj * projectsPerHour;
      const penalty = riskAversion * varHourly / (2 * totalAsset);
      return hourly - penalty;
    }

    /**
     * 遍历所有合理的 protectLevel，返回 hourlyCost 最大的（和 milkonomy 高亮逻辑一致）
     */
    function computeBestMetrics(itemHrid, targetLevel, buffs, state, productPrice = null) {
      if (productPrice === null) {
        productPrice = getMarketAskPrice(itemHrid, targetLevel);
      }

      let best = null;
      let bestHourlyCost = -Infinity;
      for (let pl = 1; pl <= targetLevel; pl++) {
        const d = computeEnhanceMetrics(itemHrid, targetLevel, pl, 0, buffs, state);
        if (!d) continue;
        const hourlyCost = calcHourlyCost(d, productPrice);
        if (hourlyCost > bestHourlyCost) {
          bestHourlyCost = hourlyCost;
          best = { ...d, protectLevel: pl };
        }
      }
      return best;
    }

    // ═══════════════════════════════════════════════
    //  自定义 Tooltip
    // ═══════════════════════════════════════════════

    let tooltipStyleInjected = false;
    let tooltipEl = null;
    let tooltipHideTimer = null;

    function injectTooltipStyle() {
      if (tooltipStyleInjected) return;
      tooltipStyleInjected = true;
      const style = document.createElement("style");
      style.textContent = `
        .hrshow-tooltip {
          position: fixed;
          z-index: 99999;
          pointer-events: none;
          background: rgba(20, 20, 30, 0.95);
          color: #e0e0e0;
          border: 1px solid #555;
          border-radius: 6px;
          padding: 8px 12px;
          font-size: 12px;
          line-height: 1.6;
          white-space: pre-line;
          max-width: 360px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          opacity: 0;
          transition: opacity 0.15s ease;
        }
        .hrshow-tooltip.visible { opacity: 1; }
        .hrshow-tooltip .tt-label { color: #aaa; }
        .hrshow-tooltip .tt-value { color: #FFD700; }
        .hrshow-tooltip .tt-profit-pos { color: #67c23a; }
        .hrshow-tooltip .tt-profit-neg { color: #FF6666; }
        .hrshow-tooltip .tt-header {
          color: #fff;
          font-weight: bold;
          margin-bottom: 4px;
          border-bottom: 1px solid #444;
          padding-bottom: 4px;
        }
      `;
      document.head.appendChild(style);
    }

    function getTooltipEl() {
      if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
      tooltipEl = document.createElement("div");
      tooltipEl.className = "hrshow-tooltip";
      document.body.appendChild(tooltipEl);
      return tooltipEl;
    }

    function clearTooltipHideTimer() {
      if (!tooltipHideTimer) return;
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    function scheduleTooltipHide(delay = 3000) {
      clearTooltipHideTimer();
      tooltipHideTimer = setTimeout(() => {
        hideTooltip();
      }, delay);
    }

    function getEventPoint(e) {
      if (e?.touches?.[0]) {
        return { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY };
      }
      if (e?.changedTouches?.[0]) {
        return { clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY };
      }
      if (Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
        return { clientX: e.clientX, clientY: e.clientY };
      }
      return null;
    }

    function showTooltip(e, html, anchorEl = null) {
      const tip = getTooltipEl();
      tip.innerHTML = html;
      tip.classList.add("visible");
      positionTooltip(e, tip, anchorEl);
    }

    function positionTooltip(e, tip, anchorEl = null) {
      const pad = 12;
      const point = getEventPoint(e);
      let x;
      let y;
      if (point) {
        x = point.clientX + pad;
        y = point.clientY + pad;
      } else if (anchorEl?.getBoundingClientRect) {
        const anchorRect = anchorEl.getBoundingClientRect();
        x = anchorRect.left + anchorRect.width / 2 + pad;
        y = anchorRect.top + anchorRect.height / 2 + pad;
      } else {
        x = pad;
        y = pad;
      }
      const rect = tip.getBoundingClientRect();
      if (x + rect.width > window.innerWidth - pad) {
        x = point ? point.clientX - rect.width - pad : window.innerWidth - rect.width - pad;
      }
      if (y + rect.height > window.innerHeight - pad) {
        y = point ? point.clientY - rect.height - pad : window.innerHeight - rect.height - pad;
      }
      tip.style.left = Math.max(pad, x) + "px";
      tip.style.top = Math.max(pad, y) + "px";
    }

    function hideTooltip() {
      clearTooltipHideTimer();
      const tip = getTooltipEl();
      tip.classList.remove("visible");
    }

    function bindTooltip(el, htmlContent) {
      el.addEventListener("click", e => {
        e.stopPropagation();
        showTooltip(e, htmlContent, el);
        scheduleTooltipHide(3000);
      });
    }

    function buildTooltipHtml(enhancementLevel, metrics, price, totalAsset) {
      const afterTax = price * SELL_TAX_FACTOR;
      const profitPerItem = afterTax - metrics.totalCostNoHourly;
      const hourlyCost = calcHourlyCost(metrics, price);
      const profitClass = profitPerItem >= 0 ? "tt-profit-pos" : "tt-profit-neg";
      let html = `<div class="tt-header">0→+${enhancementLevel} (保护+${metrics.protectLevel})</div>`
        + `<span class="tt-label">挂单价:</span> <span class="tt-value">${formatMoney(price)}</span>\n`
        + `<span class="tt-label">税后:</span> <span class="tt-value">${formatMoney(afterTax)}</span>\n`
        + `<span class="tt-label">白板(${metrics.whiteSource}):</span> <span class="tt-value">${formatMoney(metrics.whitePrice)}</span>\n`
        + `<span class="tt-label">强化消耗:</span> <span class="tt-value">${formatMoney(metrics.consumeCost)}</span>\n`
        + `<span class="tt-label">总成本:</span> <span class="tt-value">${formatMoney(metrics.totalCostNoHourly)}</span>\n`
        + `<span class="tt-label">单件利润:</span> <span class="${profitClass}">${formatMoney(profitPerItem)}</span>\n`
        + `<span class="tt-label">工时费/h:</span> <span class="${hourlyCost >= 0 ? "tt-profit-pos" : "tt-profit-neg"}">${formatMoney(hourlyCost)}</span>\n`;

      const riskHourly = calcRiskAdjustedHourlyCost(metrics, price, totalAsset);
      if (Number.isFinite(riskHourly)) {
        html += `<span class="tt-label">风控工时费/h:</span> <span class="${riskHourly >= 0 ? "tt-profit-pos" : "tt-profit-neg"}">${formatMoney(riskHourly)}</span>\n`
          + `<span class="tt-label">流动资产W:</span> <span class="tt-value">${formatMoney(totalAsset)}</span>\n`;
      }

      html += `<span class="tt-label">期望动作:</span> <span class="tt-value">${Math.round(metrics.actions)}</span>\n`
        + `<span class="tt-label">每小时动作:</span> <span class="tt-value">${metrics.actionsPH.toFixed(1)}</span>`;
      return html;
    }

    // ═══════════════════════════════════════════════
    //  DOM 操作
    // ═══════════════════════════════════════════════

    const MARKER_CLASS = "HourlyRateShowInfo";
    const MARKER_SET_CLASS = "HourlyRateShowInfoSet";

    function clearAllInserted() {
      document.querySelectorAll(`.${MARKER_SET_CLASS}`).forEach(n => n.classList.remove(MARKER_SET_CLASS));
      document.querySelectorAll(`.${MARKER_CLASS}`).forEach(n => n.remove());
      hideTooltip();
    }

    function formatMoney(value) {
      if (!Number.isFinite(value)) return "N/A";
      const abs = Math.abs(value);
      const sign = value < 0 ? "-" : "";
      if (abs < 1000) return sign + Math.round(abs).toString();
      if (abs < 1e6) return sign + (abs / 1000).toFixed(1) + "K";
      if (abs < 1e9) return sign + (abs / 1e6).toFixed(2) + "M";
      return sign + (abs / 1e9).toFixed(2) + "B";
    }

    function parsePrice(priceText) {
      if (!priceText) return 0;
      const text = String(priceText).replace(/[^\d.KMBkmb]/g, "").toUpperCase();
      const number = parseFloat(text.replace(/[KMB]/g, ""));
      if (!Number.isFinite(number)) return 0;
      if (text.includes("B")) return number * 1e9;
      if (text.includes("M")) return number * 1e6;
      if (text.includes("K")) return number * 1e3;
      return number;
    }

    // ═══════════════════════════════════════════════
    //  读取 MWITools 注入的流动资产。26.4.8 起资产卡片移到库存页，
    //  并把每日快照保存在 MWITools_asset_history_v1；最后保留旧顶部栏兼容。
    // ═══════════════════════════════════════════════
    let _currentAssetsCache = { value: null, time: 0 };
    function getCurrentAssetsFromMWITools() {
      const now = Date.now();
      if (now - _currentAssetsCache.time < 5000) return _currentAssetsCache.value;

      let value = null;
      try {
        // MWITools 26.4.8：库存页“流动资产”小计。只读现有 DOM，不触发刷新。
        const liquidSubtotal = document.querySelector('#toggleCurrentAssets .mwi-asset-subtotal');
        if (liquidSubtotal) {
          const parsed = parsePrice(liquidSubtotal.textContent || "");
          if (Number.isFinite(parsed) && parsed > 0) value = parsed;
        }

        // 排行榜通常在市场页，此时库存卡片可能已卸载；读取 MWITools 已写入的
        // 本地资产快照。优先匹配当前角色，无法匹配时才选择最新角色快照。
        if (!(value > 0)) {
          try {
            const stored = JSON.parse(localStorage.getItem("MWITools_asset_history_v1") || "null");
            const roles = stored?.roles && typeof stored.roles === "object"
              ? Object.values(stored.roles)
              : [];
            const knownCharacterId = String(window.__MWI_PROFIT_CURRENT_CHARACTER_ID__ || "unknown");
            const matchingRoles = knownCharacterId !== "unknown"
              ? roles.filter(role => String(role?.characterId ?? "") === knownCharacterId)
              : [];
            const candidates = matchingRoles.length ? matchingRoles : roles;
            let newest = null;
            for (const role of candidates) {
              for (const record of Object.values(role?.days || {})) {
                const liquid = Number(record?.values?.liquid);
                if (!(liquid > 0)) continue;
                const recordedAt = Date.parse(record?.recordedAt || "") || 0;
                if (!newest || recordedAt > newest.recordedAt) newest = { liquid, recordedAt };
              }
            }
            if (newest) value = newest.liquid;
          } catch (_) {}
        }

        // MWITools 旧版：顶部等级右侧的 Current Assets 文本。
        if (!(value > 0)) {
          const header = document.querySelector('div[class*="Header_totalLevel"]');
          let el = header?.nextElementSibling;
          const assetPattern = /(?:Current Assets|当前资产)\s*[:：]\s*([\d.,]+\s*[KMBkmb]?)/i;
          if (!el || !assetPattern.test(el.textContent || "")) {
            el = null;
            const candidates = document.querySelectorAll('div,span');
            for (const c of candidates) {
              const t = c.textContent || "";
              if (assetPattern.test(t) && t.length < 200) { el = c; break; }
            }
          }
          if (el) {
            const text = el.textContent || "";
            const m = text.match(assetPattern);
            if (m) {
              const v = parsePrice(m[1]);
              if (Number.isFinite(v) && v > 0) value = v;
            }
          }
        }
      } catch (_) {
        value = null;
      }
      _currentAssetsCache = { value, time: now };
      return value;
    }

    function formatExp(exp) {
      if (!Number.isFinite(exp) || exp < 0) return "N/A";
      if (exp < 1000) return Math.round(exp).toString();
      if (exp < 1e6) return (exp / 1000).toFixed(1) + "K";
      return (exp / 1e6).toFixed(2) + "M";
    }

    function insertOrderBooksInfo(rootNode) {
      const container = rootNode.querySelector('[class*="MarketplacePanel_orderBooksContainer"]');
      if (!container) return;

      const askTable = container.firstChild?.firstChild;
      const bidTable = container.lastChild?.firstChild;
      if (!askTable || !bidTable) return;

      if (askTable.classList.contains(MARKER_SET_CLASS)) return;

      const itemNode = rootNode.querySelector('[class*="MarketplacePanel_currentItem"] [class*="Item_item"]');
      if (!itemNode) return;

      const svgUse = itemNode.querySelector("use");
      if (!svgUse) return;
      const svgHref = svgUse.href?.baseVal || svgUse.getAttribute("href") || "";
      const itemKey = svgHref.split("#")[1];
      if (!itemKey) return;
      const itemHrid = "/items/" + itemKey;

      const enhanceLevelNode = itemNode.querySelector('[class*="Item_enhancementLevel"]');
      const enhancementLevel = enhanceLevelNode
        ? Number(enhanceLevelNode.textContent.replace(/\+/g, ""))
        : 0;

      if (enhancementLevel < 1) return;

      const state = getGameState();
      if (!state) { console.warn("[HourlyRate] gameState not found"); return; }

      const item = getItemDetail(itemHrid, state);
      if (!item?.enhancementCosts) return;

      clearAllInserted();

      const buffs = computeEnhancingBuffs(state);
      if (!buffs) return;

      // 缓存不同价格对应的最优 metrics
      const metricsCache = new Map();
      function getMetricsForPrice(price) {
        if (metricsCache.has(price)) return metricsCache.get(price);
        const m = computeBestMetrics(itemHrid, enhancementLevel, buffs, state, price);
        metricsCache.set(price, m);
        return m;
      }

      function createInfoCell(text = "") {
        const td = document.createElement("td");
        td.classList.add(MARKER_CLASS);
        td.style.cssText = "font-size:0.7rem;white-space:nowrap;text-align:center;padding:2px 4px;";
        td.textContent = text;
        return td;
      }

      function setPendingCell(td) {
        td.textContent = "...";
        td.style.color = "#888";
      }

      function setUnavailableCell(td) {
        td.textContent = "-";
        td.style.color = "#888";
      }

      function scheduleFillCells(fn) {
        setTimeout(fn, 0);
      }

      function injectTable(tableNode, isAskSide) {
        tableNode.classList.add(MARKER_SET_CLASS);

        const thead = tableNode.querySelector("thead tr");
        if (!thead) return;

        const rateTh = document.createElement("th");
        rateTh.textContent = "工时费/h";
        rateTh.classList.add(MARKER_CLASS);
        rateTh.style.cssText = "font-size:0.7rem;color:#FFD700;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(rateTh, thead.lastChild);

        const riskTh = document.createElement("th");
        riskTh.textContent = "风控工时费/h";
        riskTh.classList.add(MARKER_CLASS);
        riskTh.style.cssText = "font-size:0.7rem;color:#FFB86B;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(riskTh, thead.lastChild);

        const expTh = document.createElement("th");
        expTh.textContent = "经验/h";
        expTh.classList.add(MARKER_CLASS);
        expTh.style.cssText = "font-size:0.7rem;color:#AAFFAA;white-space:nowrap;text-align:center;padding:2px 4px;";
        thead.insertBefore(expTh, thead.lastChild);

        // 行渲染里会用到；为整块表格只读取一次 W
        const totalAsset = getCurrentAssetsFromMWITools();

        const listings = getOrderBookListings(itemHrid, enhancementLevel, isAskSide);

        const rows = tableNode.querySelectorAll("tbody tr");
        const fillJobs = [];
        let lastPrice = null;
        let rowIndex = 0;

        for (const row of rows) {
          const listing = listings[rowIndex];
          const price = listing?.price || 0;
          const isFirstOfPrice = price !== lastPrice;
          lastPrice = price;

          const rateTd = createInfoCell();
          const riskTd = createInfoCell();
          const expTd = createInfoCell();
          if (isFirstOfPrice) {
            setPendingCell(rateTd);
            setPendingCell(expTd);
            if (totalAsset) setPendingCell(riskTd);
          }
          row.insertBefore(rateTd, row.lastChild);
          row.insertBefore(riskTd, row.lastChild);
          row.insertBefore(expTd, row.lastChild);

          fillJobs.push({ rateTd, riskTd, expTd, price, isFirstOfPrice });

          rowIndex++;
        }

        scheduleFillCells(() => {
          if (!tableNode.isConnected || !tableNode.classList.contains(MARKER_SET_CLASS)) return;
          for (const job of fillJobs) {
            if (!job.isFirstOfPrice) continue;
            const { rateTd, riskTd, expTd, price } = job;
            if (!Number.isFinite(price) || price <= 0) {
              setUnavailableCell(rateTd);
              setUnavailableCell(expTd);
              continue;
            }

            // 针对每个价格计算最优保护等级；列已经占位，这里只回填内容。
            const metrics = getMetricsForPrice(price);
            if (!metrics) {
              setUnavailableCell(rateTd);
              setUnavailableCell(expTd);
              continue;
            }

            const hourlyCost = calcHourlyCost(metrics, price);
            rateTd.textContent = formatMoney(hourlyCost);
            rateTd.style.color = hourlyCost >= 0 ? "#FFD700" : "#FF6666";
            rateTd.style.cursor = "help";
            bindTooltip(rateTd, buildTooltipHtml(enhancementLevel, metrics, price, totalAsset));

            // 风控工时费列：检测到流动资产才计算，否则留空
            const riskHourly = calcRiskAdjustedHourlyCost(metrics, price, totalAsset);
            if (Number.isFinite(riskHourly)) {
              riskTd.textContent = formatMoney(riskHourly);
              riskTd.style.color = riskHourly >= 0 ? "#FFB86B" : "#FF6666";
              riskTd.style.cursor = "help";
              bindTooltip(riskTd, buildTooltipHtml(enhancementLevel, metrics, price, totalAsset));
            } else {
              riskTd.textContent = "";
            }

            // 经验列也使用该价格对应的 metrics
            expTd.textContent = formatExp(metrics.expPerHour);
            expTd.style.color = "#AAFFAA";
          }
        });
      }

      injectTable(askTable, true);
      injectTable(bidTable, false);
    }

    // ═══════════════════════════════════════════════
    //  私人功能：玩家名字左侧的“工具箱”入口与强化榜弹窗
    //  只读取已缓存的公开市场快照与本地游戏状态。
    //  不调用游戏 API、不发送 WebSocket 消息、不逐物品请求订单簿。
    // ═══════════════════════════════════════════════

    const rankingUi = {
      button: null,
      menu: null,
      anchorName: null,
      overlay: null,
      dialog: null,
      panel: null,
      rows: [],
      calculating: false,
      calculationToken: 0,
      lastCalculationMs: null,
      integrationTimer: null
    };

    function escapeRankingHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function createRankingPanel() {
      const panel = document.createElement("section");
      panel.id = "enhance-hourly-ranking-panel";
      panel.innerHTML = `
        <style>
          #enhance-hourly-ranking-panel[hidden]{display:none!important}
          #enhance-hourly-ranking-panel{height:100%;min-height:0;overflow:hidden;color:#e7e8f5;background:#171824;font-size:12px}
          #enhance-hourly-ranking-panel *{box-sizing:border-box}
          #enhance-hourly-ranking-panel .ehr-wrap{height:100%;display:flex;flex-direction:column;min-height:0;padding:10px}
          #enhance-hourly-ranking-panel .ehr-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
          #enhance-hourly-ranking-panel h3{margin:0;color:#fff;font-size:15px}
          #enhance-hourly-ranking-panel .ehr-note{margin:0 0 8px;color:#aeb1ca;line-height:1.45}
          #enhance-hourly-ranking-panel .ehr-controls{display:grid;grid-template-columns:minmax(120px,1fr) minmax(95px,.65fr) 82px auto;gap:6px;margin-bottom:8px}
          #enhance-hourly-ranking-panel input,#enhance-hourly-ranking-panel select,#enhance-hourly-ranking-panel button{min-height:30px;border:1px solid #454864;border-radius:4px;background:#25273a;color:#f3f3fa;padding:4px 7px}
          #enhance-hourly-ranking-panel button{border-color:#43c4ad;background:#43c4ad;color:#10201f;font-weight:700;cursor:pointer}
          #enhance-hourly-ranking-panel button:disabled{opacity:.55;cursor:wait}
          #enhance-hourly-ranking-panel .ehr-status{min-height:18px;margin-bottom:6px;color:#c9cbeb}
          #enhance-hourly-ranking-panel .ehr-table-wrap{flex:1;min-height:0;overflow:auto;border:1px solid #35384f;border-radius:4px}
          #enhance-hourly-ranking-panel table{width:100%;border-collapse:collapse;white-space:nowrap;font-size:11px}
          #enhance-hourly-ranking-panel th{position:sticky;top:0;z-index:1;background:#25273a;color:#dfe1f4;text-align:right;padding:6px;border-bottom:1px solid #4a4d69}
          #enhance-hourly-ranking-panel th:nth-child(1),#enhance-hourly-ranking-panel th:nth-child(2){text-align:left}
          #enhance-hourly-ranking-panel td{padding:5px 6px;text-align:right;border-bottom:1px solid #2c2e42}
          #enhance-hourly-ranking-panel td:nth-child(1),#enhance-hourly-ranking-panel td:nth-child(2){text-align:left}
          #enhance-hourly-ranking-panel tbody tr:hover{background:#242638}
          #enhance-hourly-ranking-panel .ehr-positive{color:#7be0bc}
          #enhance-hourly-ranking-panel .ehr-negative{color:#ff7b82}
          #enhance-hourly-ranking-panel .ehr-muted{color:#888ca7}
          @media (max-width:900px){#enhance-hourly-ranking-panel .ehr-controls{grid-template-columns:1fr 1fr}#enhance-hourly-ranking-panel .ehr-controls button{grid-column:span 2}}
        </style>
        <div class="ehr-wrap">
          <div class="ehr-title"><h3>强化收购价排行榜</h3><span>0 → 目标等级</span></div>
          <p class="ehr-note">仅使用公开市场快照中的最高收购价（Bid），按税后 95% 收入计算。排行榜计算完全在本地完成。</p>
          <div class="ehr-controls">
            <input data-role="ranking-search" type="search" placeholder="筛选物品名称 / HRID">
            <select data-role="ranking-sort" title="排序指标">
              <option value="hourly">工时费/h 从高到低</option>
              <option value="risk">风控工时费/h 从高到低</option>
              <option value="exp">经验/h 从高到低</option>
            </select>
            <select data-role="ranking-limit" title="显示数量">
              <option value="50">前 50</option>
              <option value="100">前 100</option>
              <option value="250">前 250</option>
              <option value="0">全部</option>
            </select>
            <button data-role="ranking-refresh" type="button">本地重算</button>
          </div>
          <div class="ehr-status" data-role="ranking-status">打开排行榜后开始计算。</div>
          <div class="ehr-table-wrap">
            <table>
              <thead><tr>
                <th>#</th><th>物品</th><th>目标</th><th>最高收购价</th><th>工时费/h</th><th>风控工时费/h</th><th>经验/h</th><th>保护起点</th><th>预计成本</th><th>预计耗时</th>
              </tr></thead>
              <tbody data-role="ranking-body"></tbody>
            </table>
          </div>
        </div>`;

      panel.querySelector('[data-role="ranking-sort"]').addEventListener("change", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-limit"]').addEventListener("change", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-search"]').addEventListener("input", () => renderRankingRows(panel));
      panel.querySelector('[data-role="ranking-refresh"]').addEventListener("click", () => calculateRanking(panel, true));
      return panel;
    }

    function rankingValueClass(value) {
      if (!Number.isFinite(value)) return "ehr-muted";
      return value >= 0 ? "ehr-positive" : "ehr-negative";
    }

    function formatRankingHours(hours) {
      if (!Number.isFinite(hours)) return "N/A";
      if (hours < 1 / 60) return `${Math.max(1, Math.round(hours * 3600))}秒`;
      if (hours < 1) return `${(hours * 60).toFixed(1)}分`;
      return `${hours.toFixed(hours < 10 ? 2 : 1)}时`;
    }

    function renderRankingRows(panel) {
      if (!panel || !panel.isConnected) return;
      const body = panel.querySelector('[data-role="ranking-body"]');
      const status = panel.querySelector('[data-role="ranking-status"]');
      const sortKey = panel.querySelector('[data-role="ranking-sort"]').value;
      const limit = Number(panel.querySelector('[data-role="ranking-limit"]').value);
      const query = panel.querySelector('[data-role="ranking-search"]').value.trim().toLowerCase();
      const valueKey = sortKey === "risk" ? "riskHourly" : sortKey === "exp" ? "expPerHour" : "hourly";

      let rows = rankingUi.rows.filter((row) => {
        if (sortKey === "risk" && !Number.isFinite(row.riskHourly)) return false;
        return !query || row.itemName.toLowerCase().includes(query) || row.itemHrid.toLowerCase().includes(query);
      });
      rows.sort((a, b) => {
        const av = Number.isFinite(a[valueKey]) ? a[valueKey] : -Infinity;
        const bv = Number.isFinite(b[valueKey]) ? b[valueKey] : -Infinity;
        return bv - av || b.bidPrice - a.bidPrice;
      });
      const totalMatched = rows.length;
      if (limit > 0) rows = rows.slice(0, limit);

      body.innerHTML = rows.map((row, index) => `
        <tr title="${escapeRankingHtml(row.itemHrid)}">
          <td>${index + 1}</td>
          <td>${escapeRankingHtml(row.itemName)}</td>
          <td>+${row.targetLevel}</td>
          <td>${formatMoney(row.bidPrice)}</td>
          <td class="${rankingValueClass(row.hourly)}">${formatMoney(row.hourly)}</td>
          <td class="${rankingValueClass(row.riskHourly)}">${Number.isFinite(row.riskHourly) ? formatMoney(row.riskHourly) : "N/A"}</td>
          <td>${formatExp(row.expPerHour)}</td>
          <td>+${row.protectLevel}</td>
          <td>${formatMoney(row.totalCost)}</td>
          <td>${formatRankingHours(row.totalTimeHours)}</td>
        </tr>`).join("");

      if (!rankingUi.calculating) {
        const riskNote = sortKey === "risk" && totalMatched === 0
          ? "；未从 MWITools 识别到流动资产，无法计算风控时薪"
          : "";
        const timingNote = Number.isFinite(rankingUi.lastCalculationMs)
          ? `；本次计算 ${(rankingUi.lastCalculationMs / 1000).toFixed(1)} 秒`
          : "";
        status.textContent = `共 ${rankingUi.rows.length} 个有效收购项目，当前显示 ${rows.length} 个${riskNote}${timingNote}`;
      }
    }

    function getRankingJobs(state) {
      const market = getMarketCache();
      const jobs = [];
      for (const [itemHrid, levels] of Object.entries(market || {})) {
        const item = getItemDetail(itemHrid, state);
        if (!item?.enhancementCosts || !levels || typeof levels !== "object") continue;

        // Items with an enhancement material that cannot currently be bought
        // cannot produce a meaningful ranking result. Filter them before the
        // expensive enhancement simulation (not only after it returns null).
        const hasUnavailableCost = item.enhancementCosts.some((cost) =>
          getMarketAskPrice(cost.itemHrid, 0) <= 0
        );
        if (hasUnavailableCost) continue;

        for (const [levelText, quote] of Object.entries(levels)) {
          const targetLevel = Number(levelText);
          const bidPrice = Number(quote?.b);
          if (!Number.isInteger(targetLevel) || targetLevel < 1 || targetLevel > 20) continue;
          if (!Number.isFinite(bidPrice) || bidPrice <= 0) continue;
          jobs.push({ itemHrid, targetLevel, bidPrice, item });
        }
      }
      return jobs;
    }

    function yieldRankingCalculation() {
      return new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    async function calculateRanking(panel, force = false) {
      if (!panel || !panel.isConnected || rankingUi.calculating) return;
      if (!force && rankingUi.rows.length > 0) {
        renderRankingRows(panel);
        return;
      }

      const refreshButton = panel.querySelector('[data-role="ranking-refresh"]');
      const status = panel.querySelector('[data-role="ranking-status"]');
      const state = getGameState();
      if (!state) {
        status.textContent = "无法读取游戏状态。请刷新游戏后重试。";
        return;
      }
      const buffs = computeEnhancingBuffs(state);
      if (!buffs) {
        status.textContent = "无法读取游戏基础数据。请等待游戏加载完成后重试。";
        return;
      }
      const jobs = getRankingJobs(state);
      if (jobs.length === 0) {
        status.textContent = "公开市场快照尚未加载，或没有有效的强化收购报价。";
        return;
      }

      rankingUi.calculating = true;
      rankingUi.rows = [];
      rankingUi.lastCalculationMs = null;
      const token = ++rankingUi.calculationToken;
      const calculationStartedAt = performance.now();
      refreshButton.disabled = true;
      const totalAsset = getCurrentAssetsFromMWITools();
      status.textContent = `准备本地计算 ${jobs.length} 个项目…`;

      try {
        // 先让浏览器完成弹窗绘制，再分片执行强化模拟。计算片段不宜过短，
        // 否则浏览器的定时器钳制和进度 DOM 重绘会显著拉长总耗时。
        await yieldRankingCalculation();
        let sliceStartedAt = performance.now();
        let lastProgressAt = sliceStartedAt;
        for (let index = 0; index < jobs.length; index++) {
          if (token !== rankingUi.calculationToken || !panel.isConnected) return;
          const job = jobs[index];
          const metrics = computeBestMetrics(job.itemHrid, job.targetLevel, buffs, state, job.bidPrice);
          if (metrics) {
            const hourly = calcHourlyCost(metrics, job.bidPrice);
            const riskHourly = calcRiskAdjustedHourlyCost(metrics, job.bidPrice, totalAsset);
            if (Number.isFinite(hourly) && Number.isFinite(metrics.expPerHour)) {
              rankingUi.rows.push({
                itemHrid: job.itemHrid,
                itemName: PRIVATE_ZH_ITEM_HRIDS[job.itemHrid]
                  || PRIVATE_ZH_ITEM_NAMES[job.item?.name]
                  || job.item?.name
                  || job.itemHrid.split("/").pop().replaceAll("_", " "),
                targetLevel: job.targetLevel,
                bidPrice: job.bidPrice,
                hourly,
                riskHourly: Number.isFinite(riskHourly) ? riskHourly : null,
                expPerHour: metrics.expPerHour,
                protectLevel: metrics.protectLevel,
                totalCost: metrics.totalCostNoHourly,
                totalTimeHours: metrics.totalTimeHours
              });
            }
          }

          const now = performance.now();
          const isLastJob = index === jobs.length - 1;
          if (now - lastProgressAt >= 200 || isLastJob) {
            status.textContent = `本地计算中 ${index + 1}/${jobs.length}；没有发送物品或订单请求…`;
            lastProgressAt = now;
          }
          if (now - sliceStartedAt >= 30 && !isLastJob) {
            await yieldRankingCalculation();
            sliceStartedAt = performance.now();
          }
        }
      } catch (error) {
        console.error("[HourlyRate Ranking]", error);
        status.textContent = `排行榜计算失败：${error?.message || error}`;
      } finally {
        if (token === rankingUi.calculationToken) {
          rankingUi.calculating = false;
          rankingUi.lastCalculationMs = performance.now() - calculationStartedAt;
          refreshButton.disabled = false;
          renderRankingRows(panel);
        }
      }
    }

    function findHeaderPlayerName() {
      const headerInfoElements = document.querySelectorAll('[class*="Header_info"]');
      let fallback = null;
      for (const headerInfo of headerInfoElements) {
        const directName = Array.from(headerInfo.children).find((element) =>
          Array.from(element.classList || []).some((className) => className.startsWith("Header_name"))
        );
        const nameElement = directName || headerInfo.querySelector('[class*="Header_name"]');
        if (!nameElement?.querySelector?.("[data-name]")) continue;
        fallback ||= nameElement;
        const rect = nameElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return nameElement;
      }
      return fallback;
    }

    function positionToolkitButton() {
      const button = rankingUi.button;
      const nameElement = rankingUi.anchorName;
      if (!button?.isConnected || !nameElement?.isConnected) return;
      const nameRect = nameElement.getBoundingClientRect();
      if (nameRect.width <= 0 || nameRect.height <= 0) {
        button.hidden = true;
        return;
      }
      button.hidden = false;
      const buttonWidth = button.offsetWidth || 50;
      const buttonHeight = button.offsetHeight || 20;
      const gap = 4;
      const viewportLeft = window.visualViewport?.offsetLeft || 0;
      const viewportTop = window.visualViewport?.offsetTop || 0;
      button.style.left = Math.max(viewportLeft + 4, nameRect.left - buttonWidth - gap) + "px";
      button.style.top = Math.max(viewportTop + 4, nameRect.top + (nameRect.height - buttonHeight) / 2) + "px";
    }

    function closeToolkitMenu() {
      rankingUi.menu?.remove();
      rankingUi.menu = null;
      rankingUi.button?.setAttribute("aria-expanded", "false");
    }

    function positionToolkitMenu(menu, trigger) {
      if (!menu?.isConnected || !trigger?.isConnected) return;
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft || 0;
      const viewportTop = viewport?.offsetTop || 0;
      const viewportWidth = viewport?.width || document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = viewport?.height || document.documentElement.clientHeight || window.innerHeight;
      const margin = 8;
      const gap = 5;
      const left = Math.max(
        viewportLeft + margin,
        Math.min(triggerRect.right - menuRect.width, viewportLeft + viewportWidth - menuRect.width - margin)
      );
      const below = triggerRect.bottom + gap;
      const above = triggerRect.top - menuRect.height - gap;
      const top = below + menuRect.height <= viewportTop + viewportHeight - margin
        ? below
        : Math.max(viewportTop + margin, above);
      menu.style.left = left + "px";
      menu.style.top = top + "px";
    }

    function toggleToolkitMenu() {
      if (rankingUi.menu?.isConnected) {
        closeToolkitMenu();
        return;
      }
      const trigger = rankingUi.button;
      if (!trigger?.isConnected) return;
      const menu = document.createElement("div");
      menu.id = "mwi-enhance-toolkit-menu";
      menu.setAttribute("role", "menu");
      menu.innerHTML = `
        <div class="met-title">工具箱</div>
        <button class="met-action" type="button" role="menuitem">强化榜</button>`;
      menu.style.cssText = "position:fixed;z-index:2147483644;display:flex;min-width:132px;flex-direction:column;gap:4px;padding:7px;border:1px solid #555a7a;border-radius:5px;background:#27283b;box-shadow:0 6px 20px rgba(0,0,0,.45);color:#e7e7e7;font:13px/1.2 Roboto,Helvetica,Arial,sans-serif;";
      const title = menu.querySelector(".met-title");
      title.style.cssText = "padding:4px 7px 7px;border-bottom:1px solid #3b3d60;text-align:center;font-weight:700;";
      const action = menu.querySelector(".met-action");
      action.style.cssText = "min-height:30px;padding:4px 9px;border:1px solid #454771;border-radius:4px;background:#2c2e45;color:#e7e7e7;font:inherit;text-align:left;cursor:pointer;";
      action.addEventListener("mouseenter", () => { action.style.background = "#323450"; });
      action.addEventListener("mouseleave", () => { action.style.background = "#2c2e45"; });
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeToolkitMenu();
        openRankingModal();
      });
      menu.addEventListener("click", (event) => event.stopPropagation());
      document.body.append(menu);
      rankingUi.menu = menu;
      trigger.setAttribute("aria-expanded", "true");
      window.requestAnimationFrame(() => positionToolkitMenu(menu, trigger));
    }

    function closeRankingModal() {
      if (!rankingUi.overlay) return;
      rankingUi.overlay.hidden = true;
      rankingUi.button?.setAttribute("aria-expanded", "false");
    }

    function createRankingModal() {
      if (rankingUi.overlay?.isConnected) return;
      const overlay = document.createElement("div");
      overlay.id = "enhance-ranking-floating-overlay";
      overlay.hidden = true;
      overlay.innerHTML = `
        <style>
          #enhance-ranking-floating-overlay[hidden]{display:none!important}
          #enhance-ranking-floating-overlay{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;padding:3vh 3vw;background:rgba(5,6,12,.72);box-sizing:border-box}
          #enhance-ranking-floating-overlay *{box-sizing:border-box}
          #enhance-ranking-floating-dialog{width:min(1180px,94vw);height:min(820px,92vh);min-width:0;min-height:320px;display:flex;flex-direction:column;overflow:hidden;contain:layout paint style;border:1px solid #555a7a;border-radius:10px;background:#171824;box-shadow:0 20px 60px rgba(0,0,0,.55);color:#e7e8f5}
          #enhance-ranking-floating-dialog .ehr-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:9px 12px;border-bottom:1px solid #383b55;background:#222438}
          #enhance-ranking-floating-dialog .ehr-modal-head strong{font-size:15px;color:#fff}
          #enhance-ranking-floating-dialog .ehr-modal-close{width:32px;height:32px;padding:0;border:1px solid #555a7a;border-radius:6px;background:#30334b;color:#f5f5fb;font-size:24px;line-height:28px;cursor:pointer}
          #enhance-ranking-floating-dialog .ehr-modal-close:hover{background:#474b6d}
          #enhance-ranking-floating-dialog .ehr-modal-body{flex:1;min-height:0;overflow:hidden}
          @media (max-width:700px){#enhance-ranking-floating-overlay{padding:2vh 1vw}#enhance-ranking-floating-dialog{width:98vw;height:94vh}}
        </style>
        <div id="enhance-ranking-floating-dialog" role="dialog" aria-modal="true" aria-labelledby="enhance-ranking-floating-title">
          <div class="ehr-modal-head">
            <strong id="enhance-ranking-floating-title">强化榜</strong>
            <button class="ehr-modal-close" type="button" aria-label="关闭强化榜" title="关闭（Esc）">×</button>
          </div>
          <div class="ehr-modal-body"></div>
        </div>`;
      const dialog = overlay.querySelector("#enhance-ranking-floating-dialog");
      const panel = createRankingPanel();
      overlay.querySelector(".ehr-modal-body").append(panel);
      overlay.querySelector(".ehr-modal-close").addEventListener("click", closeRankingModal);
      overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) closeRankingModal();
      });
      document.body.append(overlay);
      rankingUi.overlay = overlay;
      rankingUi.dialog = dialog;
      rankingUi.panel = panel;
    }

    function openRankingModal() {
      createRankingModal();
      rankingUi.overlay.hidden = false;
      renderRankingRows(rankingUi.panel);
      rankingUi.dialog.querySelector(".ehr-modal-close")?.focus({ preventScroll: true });
      window.requestAnimationFrame(() => {
        window.setTimeout(() => calculateRanking(rankingUi.panel), 0);
      });
    }

    function ensureHeaderToolkitButton() {
      const nameElement = findHeaderPlayerName();
      if (!nameElement) {
        if (rankingUi.button) rankingUi.button.hidden = true;
        closeToolkitMenu();
        return;
      }
      if (rankingUi.button?.isConnected) {
        rankingUi.anchorName = nameElement;
        positionToolkitButton();
        return;
      }
      document.getElementById("mwi-enhance-toolkit-button")?.remove();
      const button = document.createElement("button");
      button.id = "mwi-enhance-toolkit-button";
      button.type = "button";
      button.textContent = "工具箱";
      button.title = "强化工具箱";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-controls", "mwi-enhance-toolkit-menu");
      button.setAttribute("aria-expanded", "false");
      button.style.cssText = "position:fixed;z-index:2147483643;display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:20px;padding:0 5px;border:1px solid var(--color-space-400,#7184d8);border-radius:2px;background:var(--color-midnight-500,#2c2e45);color:var(--color-space-100,#dde2f8);font:500 12px/1.2 Roboto,Helvetica,Arial,sans-serif;white-space:nowrap;cursor:pointer;";
      button.addEventListener("mouseenter", () => { button.style.background = "var(--color-midnight-400,#323450)"; });
      button.addEventListener("mouseleave", () => { button.style.background = "var(--color-midnight-500,#2c2e45)"; });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleToolkitMenu();
      });
      document.body.append(button);
      rankingUi.button = button;
      rankingUi.anchorName = nameElement;
      window.requestAnimationFrame(positionToolkitButton);
    }

    function startHeaderToolkitIntegration() {
      window.setTimeout(ensureHeaderToolkitButton, 500);
      rankingUi.integrationTimer = window.setInterval(ensureHeaderToolkitButton, 2000);
      document.addEventListener("click", closeToolkitMenu);
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (rankingUi.menu?.isConnected) closeToolkitMenu();
        else if (rankingUi.overlay && !rankingUi.overlay.hidden) closeRankingModal();
      });
      const reposition = () => {
        positionToolkitButton();
        if (rankingUi.menu?.isConnected) positionToolkitMenu(rankingUi.menu, rankingUi.button);
      };
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
      window.visualViewport?.addEventListener("resize", reposition);
      window.visualViewport?.addEventListener("scroll", reposition);
    }

    // ═══════════════════════════════════════════════
    //  强化决策辅助（独立于既有强化榜与工时费计算）
    //  已发生账本只用于本次实际盈亏；Bellman EV 仅从当前等级开始。
    // ═══════════════════════════════════════════════

    const enhancementDecision = {
      itemHrid: null,
      itemName: "",
      currentLevel: null,
      targetLevel: 20,
      protectLevel: 1,
      protectionItemHrid: null,
      lastActionCount: null,
      actions: 0,
      successes: 0,
      failures: 0,
      leaps: 0,
      protectionUses: 0
    };

    function clampEnhancementLevel(value, fallback = 0) {
      const level = Number(value);
      return Number.isInteger(level) && level >= 0 && level <= 20 ? level : fallback;
    }

    function parseEnhancementItemHash(hash) {
      const parts = String(hash || "").split("::");
      const itemHrid = parts.find((part) => part.startsWith("/items/")) || "";
      return {
        itemHrid,
        level: clampEnhancementLevel(parts[parts.length - 1], null)
      };
    }

    function getPreviousEnhancementLevel(message, action, itemHrid) {
      const items = Array.isArray(message?.endCharacterItems) ? message.endCharacterItems : [];
      const candidates = items.filter((item) =>
        item?.itemHrid === itemHrid && item.hash !== action.primaryItemHash
      );
      const previous = candidates.length === 1
        ? candidates[0]
        : candidates.find((item) => item.hash !== action.secondaryItemHash);
      return clampEnhancementLevel(previous?.enhancementLevel, null);
    }

    function resetEnhancementDecision(itemHrid, itemName, currentLevel, targetLevel, protectLevel) {
      Object.assign(enhancementDecision, {
        itemHrid,
        itemName,
        currentLevel,
        targetLevel,
        protectLevel,
        protectionItemHrid: null,
        lastActionCount: null,
        actions: 0,
        successes: 0,
        failures: 0,
        leaps: 0,
        protectionUses: 0
      });
    }

    function handleEnhancementActionCompleted(message) {
      const action = message?.endCharacterAction;
      if (action?.actionHrid !== ENHANCE_ACTION_HRID) return;

      const parsed = parseEnhancementItemHash(action.primaryItemHash);
      if (!parsed.itemHrid || parsed.level === null) return;
      const state = getGameState();
      const item = getItemDetail(parsed.itemHrid, state);
      const itemName = PRIVATE_ZH_ITEM_HRIDS[parsed.itemHrid]
        || PRIVATE_ZH_ITEM_NAMES[item?.name]
        || item?.name
        || parsed.itemHrid.split("/").pop().replaceAll("_", " ");
      const targetLevel = clampEnhancementLevel(action.enhancingMaxLevel, 20);
      const protectLevel = Math.max(1, Math.min(targetLevel, clampEnhancementLevel(action.enhancingProtectionMinLevel, 1)));
      const actionCount = Number(action.currentCount);
      const shouldReset = enhancementDecision.itemHrid !== parsed.itemHrid
        || (Number.isFinite(actionCount) && enhancementDecision.lastActionCount !== null
          && actionCount <= enhancementDecision.lastActionCount);
      if (shouldReset || !enhancementDecision.itemHrid) {
        resetEnhancementDecision(parsed.itemHrid, itemName, parsed.level, targetLevel, protectLevel);
      }

      const previousLevel = getPreviousEnhancementLevel(message, action, parsed.itemHrid);
      if (previousLevel !== null) {
        enhancementDecision.actions += 1;
        if (parsed.level > previousLevel) {
          enhancementDecision.successes += 1;
          if (parsed.level - previousLevel >= 2) enhancementDecision.leaps += 1;
        } else {
          enhancementDecision.failures += 1;
          if (previousLevel >= protectLevel) enhancementDecision.protectionUses += 1;
        }
      }
      const secondary = parseEnhancementItemHash(action.secondaryItemHash);
      if (secondary.itemHrid) enhancementDecision.protectionItemHrid = secondary.itemHrid;
      enhancementDecision.itemName = itemName;
      enhancementDecision.currentLevel = parsed.level;
      enhancementDecision.targetLevel = targetLevel;
      enhancementDecision.protectLevel = protectLevel;
      enhancementDecision.lastActionCount = Number.isFinite(actionCount) ? actionCount : enhancementDecision.lastActionCount;
      ensureEnhancementDecisionPanel();
    }

    function getEnhancementTransitionRates(itemHrid, level, buffs, state) {
      const icd = getInitClientData();
      const item = getItemDetail(itemHrid, state);
      const baseRate = icd?.enhancementLevelSuccessRateTable?.[level];
      if (!item || !Number.isFinite(baseRate)) return null;
      const playerLevel = getSkillLevel(state, ENHANCE_SKILL_HRID) + getBuffOf(buffs, "Level");
      const itemLevel = item.itemLevel || 0;
      const levelRatio = playerLevel >= itemLevel
        ? (playerLevel - itemLevel) * 0.0005
        : -0.5 * (1 - playerLevel / itemLevel);
      const success = Math.min(1, Math.max(0, baseRate * (1 + levelRatio + getBuffOf(buffs, "Success"))));
      const blessed = getBuffOf(buffs, "Blessed");
      return {
        success,
        normal: Math.min(1, success * (1 - blessed)),
        leap: success * blessed,
        failure: Math.max(0, 1 - success)
      };
    }

    function getEnhancementDecisionCostModel(itemHrid, protectLevel, targetLevel, state) {
      const item = getItemDetail(itemHrid, state);
      if (!item) return { error: "无法读取强化物品资料。" };
      let materialPerAction = 0;
      for (const cost of item.enhancementCosts || []) {
        const price = getMarketAskPrice(cost.itemHrid, 0);
        if (price <= 0) return { error: `强化材料没有可购买价格：${cost.itemHrid}` };
        materialPerAction += (Number(cost.count) || 0) * price;
      }

      const needsProtection = protectLevel < targetLevel;
      if (!needsProtection) return { materialPerAction, protectionPrice: 0, protectionHrid: null };
      const candidates = [];
      const possibleHrids = item.protectionItemHrids?.length > 0
        ? item.protectionItemHrids
        : [itemHrid];
      for (const hrid of possibleHrids.concat("/items/mirror_of_protection")) {
        const price = getMarketAskPrice(hrid, 0);
        if (price > 0) candidates.push({ hrid, price });
      }
      if (candidates.length === 0) return { error: "保护道具没有可购买价格，无法估算保护失败成本。" };
      const selected = candidates.find((candidate) => candidate.hrid === enhancementDecision.protectionItemHrid)
        || candidates.reduce((best, candidate) => candidate.price < best.price ? candidate : best);
      return { materialPerAction, protectionPrice: selected.price, protectionHrid: selected.hrid };
    }

    function solveEnhancementStopPolicy(itemHrid, currentLevel, targetLevel, protectLevel, costs, buffs, state) {
      const maxLevel = Math.min(20, targetLevel);
      const bids = Array.from({ length: maxLevel + 1 }, (_, level) => getMarketBidPrice(itemHrid, level) * SELL_TAX_FACTOR);
      if (bids[maxLevel] <= 0) return { error: `+${maxLevel} 没有最高求购价，无法确认递归策略的最终退出价值。` };
      const transitions = [];
      for (let level = 0; level < maxLevel; level++) {
        const rates = getEnhancementTransitionRates(itemHrid, level, buffs, state);
        if (!rates) return { error: `无法读取 +${level} 的游戏当前强化成功率。` };
        transitions[level] = {
          rates,
          cost: costs.materialPerAction + (level >= protectLevel ? rates.failure * costs.protectionPrice : 0),
          next: [
            { level: Math.min(maxLevel, level + 1), probability: rates.normal },
            { level: Math.min(maxLevel, level + 2), probability: rates.leap },
            { level: level >= protectLevel ? Math.max(0, level - 1) : 0, probability: rates.failure }
          ]
        };
      }

      let policy = Array.from({ length: maxLevel + 1 }, (_, level) => level === maxLevel || bids[level] > 0 ? "stop" : "continue");
      function evaluatePolicy(activePolicy) {
        const continueLevels = [];
        for (let level = 0; level < maxLevel; level++) if (activePolicy[level] === "continue") continueLevels.push(level);
        const index = new Map(continueLevels.map((level, i) => [level, i]));
        const size = continueLevels.length;
        const matrix = Array.from({ length: size }, (_, i) => {
          const row = new Array(size).fill(0);
          row[i] = 1;
          return row;
        });
        const costRhs = new Array(size).fill(0);
        const revenueRhs = new Array(size).fill(0);
        const actionsRhs = new Array(size).fill(1);
        for (const level of continueLevels) {
          const row = index.get(level);
          costRhs[row] = transitions[level].cost;
          for (const step of transitions[level].next) {
            const nextRow = index.get(step.level);
            if (nextRow !== undefined) matrix[row][nextRow] -= step.probability;
            else revenueRhs[row] += step.probability * bids[step.level];
          }
        }
        const inverse = size > 0 ? invertMatrix(matrix) : [];
        if (size > 0 && !inverse) return null;
        const costPart = size > 0 ? matVecMul(inverse, costRhs) : [];
        const revenuePart = size > 0 ? matVecMul(inverse, revenueRhs) : [];
        const actionsPart = size > 0 ? matVecMul(inverse, actionsRhs) : [];
        const result = Array.from({ length: maxLevel + 1 }, (_, level) => ({
          cost: 0,
          revenue: bids[level],
          actions: 0,
          value: bids[level]
        }));
        for (const level of continueLevels) {
          const row = index.get(level);
          result[level] = {
            cost: costPart[row],
            revenue: revenuePart[row],
            actions: actionsPart[row],
            value: revenuePart[row] - costPart[row]
          };
          if (!Number.isFinite(result[level].value) || result[level].actions < 0) return null;
        }
        return result;
      }

      let values = null;
      for (let iteration = 0; iteration < 40; iteration++) {
        values = evaluatePolicy(policy);
        if (!values) return { error: "当前成功率与求购单无法形成可收敛的退出策略。" };
        let changed = false;
        for (let level = 0; level < maxLevel; level++) {
          if (bids[level] <= 0) continue;
          const transition = transitions[level];
          const futureValue = transition.next.reduce((sum, step) => sum + step.probability * values[step.level].value, -transition.cost);
          const nextPolicy = futureValue > bids[level] + 1e-8 ? "continue" : "stop";
          if (nextPolicy !== policy[level]) {
            policy[level] = nextPolicy;
            changed = true;
          }
        }
        if (!changed) break;
      }
      values = evaluatePolicy(policy);
      if (!values) return { error: "递归 EV 计算未收敛。" };
      const current = transitions[currentLevel];
      if (!current) return { values, policy, bids, transitions, forcedContinue: null };
      const forcedContinue = current.next.reduce((result, step) => {
        const future = values[step.level];
        result.cost += step.probability * future.cost;
        result.revenue += step.probability * future.revenue;
        result.actions += step.probability * future.actions;
        return result;
      }, { cost: current.cost, revenue: 0, actions: 1 });
      forcedContinue.value = forcedContinue.revenue - forcedContinue.cost;
      return { values, policy, bids, transitions, forcedContinue };
    }

    function formatDecisionMoney(value) {
      return Number.isFinite(value) ? formatMoney(value) : "无法计算";
    }

    const ENHANCEMENT_DECISION_FLOAT_KEY = "MWI_enhancementDecisionFloat";
    let enhancementDecisionFloat = (() => {
      try {
        const saved = JSON.parse(localStorage.getItem(ENHANCEMENT_DECISION_FLOAT_KEY) || "{}");
        return {
          collapsed: Boolean(saved.collapsed),
          left: Number.isFinite(saved.left) ? saved.left : null,
          top: Number.isFinite(saved.top) ? saved.top : null
        };
      } catch (_) {
        return { collapsed: false, left: null, top: null };
      }
    })();
    let enhancementDecisionDragging = null;

    function saveEnhancementDecisionFloat() {
      try {
        localStorage.setItem(ENHANCEMENT_DECISION_FLOAT_KEY, JSON.stringify(enhancementDecisionFloat));
      } catch (_) {}
    }

    function positionEnhancementDecisionFloat(panel) {
      if (Number.isFinite(enhancementDecisionFloat.left) && Number.isFinite(enhancementDecisionFloat.top)) {
        panel.style.left = `${enhancementDecisionFloat.left}px`;
        panel.style.top = `${enhancementDecisionFloat.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      } else {
        panel.style.left = "auto";
        panel.style.top = "auto";
        panel.style.right = "14px";
        panel.style.bottom = "14px";
      }
    }

    function toggleEnhancementDecisionFloat() {
      enhancementDecisionFloat.collapsed = !enhancementDecisionFloat.collapsed;
      saveEnhancementDecisionFloat();
      ensureEnhancementDecisionPanel();
    }

    function bindEnhancementDecisionFloat(panel) {
      panel.addEventListener("click", (event) => {
        if (event.target?.closest?.('[data-role="float-toggle"]')) {
          if (!enhancementDecisionDragging?.moved) toggleEnhancementDecisionFloat();
        }
      });
      panel.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target?.closest?.('[data-role="float-toggle"]')
          || !event.target?.closest?.('[data-role="float-drag-handle"]')) return;
        const rect = panel.getBoundingClientRect();
        enhancementDecisionDragging = {
          panel,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          moved: false
        };
        panel.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });
      panel.addEventListener("pointermove", (event) => {
        const drag = enhancementDecisionDragging;
        if (!drag || drag.panel !== panel) return;
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const left = Math.max(0, Math.min(window.innerWidth - width, event.clientX - drag.offsetX));
        const top = Math.max(0, Math.min(window.innerHeight - height, event.clientY - drag.offsetY));
        drag.moved = true;
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        enhancementDecisionFloat.left = left;
        enhancementDecisionFloat.top = top;
      });
      const endDrag = (event) => {
        const drag = enhancementDecisionDragging;
        if (!drag || drag.panel !== panel) return;
        panel.releasePointerCapture?.(event.pointerId);
        enhancementDecisionDragging = null;
        if (drag.moved) {
          saveEnhancementDecisionFloat();
          window.setTimeout(() => { enhancementDecisionDragging = null; }, 0);
        }
      };
      panel.addEventListener("pointerup", endDrag);
      panel.addEventListener("pointercancel", endDrag);
    }

    function ensureEnhancementDecisionPanel() {
      let panel = document.getElementById("mwi-enhance-decision-panel");
      if (!panel) {
        panel = document.createElement("section");
        panel.id = "mwi-enhance-decision-panel";
        document.body.append(panel);
        bindEnhancementDecisionFloat(panel);
      }
      panel.hidden = false;
      positionEnhancementDecisionFloat(panel);
      if (enhancementDecisionFloat.collapsed) {
        panel.innerHTML = `<style>#mwi-enhance-decision-panel{position:fixed;z-index:2147483642;min-width:0;color:#eef2ff;font:12px/1.3 sans-serif}#mwi-enhance-decision-panel .med-mini{display:flex;align-items:center;gap:5px;padding:7px 9px;border:1px solid #6070ae;border-radius:18px;background:rgba(27,32,51,.88);box-shadow:0 5px 18px rgba(0,0,0,.42);user-select:none}#mwi-enhance-decision-panel .med-drag{cursor:grab;color:#aebbe8;font-weight:700}#mwi-enhance-decision-panel .med-drag:active{cursor:grabbing}#mwi-enhance-decision-panel button{border:0;background:transparent;color:#fff;font:700 12px/1 sans-serif;cursor:pointer}</style><div class="med-mini" title="拖动图标移动；点击文字展开"><span class="med-drag" data-role="float-drag-handle">⠿</span><button type="button" data-role="float-toggle">强化 EV ${enhancementDecision.currentLevel === null ? "" : `+${enhancementDecision.currentLevel}`}</button></div>`;
        return;
      }
      if (!enhancementDecision.itemHrid || enhancementDecision.currentLevel === null) {
        panel.innerHTML = `<style>#mwi-enhance-decision-panel{position:fixed;z-index:2147483642;width:min(420px,calc(100vw - 28px));min-width:0;padding:10px;border:1px solid #49516f;border-radius:7px;background:rgba(32,36,53,.90);box-shadow:0 8px 26px rgba(0,0,0,.45);color:#dfe5ff;font:12px/1.45 sans-serif}#mwi-enhance-decision-panel .med-wait-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}.med-drag{cursor:grab;color:#aebbe8;font-weight:700}.med-drag:active{cursor:grabbing}.med-collapse{border:0;border-radius:3px;background:#3a4265;color:#fff;cursor:pointer}</style><div class="med-wait-head"><span class="med-drag" data-role="float-drag-handle" title="拖动浮窗">⠿ 强化停止 / 继续 EV</span><button class="med-collapse" type="button" data-role="float-toggle" title="收起">−</button></div><div style="color:#aeb8d8">等待本脚本捕获下一次强化完成事件；统计从脚本加载后开始。</div>`;
        return;
      }
      const state = getGameState();
      const buffs = state ? computeEnhancingBuffs(state) : null;
      const level = enhancementDecision.currentLevel;
      const target = enhancementDecision.targetLevel;
      const protection = enhancementDecision.protectLevel;
      const currentBid = getMarketBidPrice(enhancementDecision.itemHrid, level);
      const stopValue = currentBid > 0 ? currentBid * SELL_TAX_FACTOR : null;
      const costModel = state ? getEnhancementDecisionCostModel(enhancementDecision.itemHrid, protection, target, state) : { error: "无法读取游戏状态。" };
      const whiteboardAsk = getMarketListingAskPrice(enhancementDecision.itemHrid, 0);
      const historicalCost = costModel.error || whiteboardAsk <= 0 ? null
        : enhancementDecision.actions * costModel.materialPerAction
          + enhancementDecision.protectionUses * costModel.protectionPrice
          + whiteboardAsk;
      const actualPnl = stopValue === null || historicalCost === null ? null : stopValue - historicalCost;
      const ev = costModel.error || !buffs ? { error: costModel.error || "无法读取当前强化 Buff。" }
        : solveEnhancementStopPolicy(enhancementDecision.itemHrid, level, target, protection, costModel, buffs, state);
      const rates = level < target && buffs ? getEnhancementTransitionRates(enhancementDecision.itemHrid, level, buffs, state) : null;
      let decisionHtml;
      if (stopValue === null) {
        decisionHtml = `<div class="med-hero med-warning"><strong>暂无法比较停止与继续</strong><span>当前 +${level} 没有有效求购单；未使用卖单价替代。</span>${ev.forcedContinue ? `<b>继续后的期望净值：${formatDecisionMoney(ev.forcedContinue.value)}</b>` : ""}</div>`;
      } else if (ev.error || !ev.forcedContinue) {
        decisionHtml = `<div class="med-hero med-warning"><strong>当前建议停止</strong><span>${escapeRankingHtml(ev.error || "已达到可强化上限，无法继续强化。")}</span><b>现在停止税后收入：${formatDecisionMoney(stopValue)}</b></div>`;
      } else {
        const difference = ev.forcedContinue.value - stopValue;
        const favorable = difference >= 0 ? "继续优势" : "停止优势";
        const color = difference >= 0 ? "#78df9f" : "#ff9a9a";
        decisionHtml = `<div class="med-hero" style="border-color:${color}"><div class="med-hero-title" style="color:${color}">${favorable} ${formatDecisionMoney(Math.abs(difference))}</div><div class="med-primary-grid"><div><span>现在停止</span><b>${formatDecisionMoney(stopValue)}</b><small>最高求购价税后</small></div><div><span>继续后的 EV</span><b>${formatDecisionMoney(ev.forcedContinue.value)}</b><small>不含已发生历史成本</small></div><div><span>优势差</span><b style="color:${color}">${formatDecisionMoney(Math.abs(difference))}</b><small>继续一手后的递归策略</small></div></div></div>`;
      }
      const observedRate = enhancementDecision.actions > 0
        ? `${(enhancementDecision.successes / enhancementDecision.actions * 100).toFixed(1)}%`
        : "—";
      const bidLevels = Array.from({ length: target + 1 }, (_, bidLevel) => {
        const bid = getMarketBidPrice(enhancementDecision.itemHrid, bidLevel);
        return `<span>+${bidLevel}：${bid > 0 ? formatMoney(bid) : "无求购"}</span>`;
      }).join("");
      const policySummary = !ev.error && ev.policy
        ? ev.policy.map((choice, policyLevel) => `+${policyLevel}${choice === "stop" ? "停" : "续"}`).join(" · ")
        : "—";
      const futureHtml = !ev.error && ev.forcedContinue
        ? `<div class="med-detail-grid"><div>期望支出 <b>${formatDecisionMoney(ev.forcedContinue.cost)}</b></div><div>期望税后收入 <b>${formatDecisionMoney(ev.forcedContinue.revenue)}</b></div><div>预计后续行动 <b>${ev.forcedContinue.actions.toFixed(2)} 次</b></div></div>`
        : "";
      panel.innerHTML = `
        <style>
          #mwi-enhance-decision-panel{position:fixed;z-index:2147483642;width:min(520px,calc(100vw - 28px));min-width:0;padding:10px;border:1px solid #49516f;border-radius:7px;background:rgba(32,36,53,.90);box-shadow:0 8px 26px rgba(0,0,0,.45);color:#dfe5ff;font:12px/1.45 sans-serif;overflow-wrap:anywhere}
          #mwi-enhance-decision-panel *{box-sizing:border-box}#mwi-enhance-decision-panel h4{display:inline;margin:0;font-size:14px;color:#fff}.med-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:7px}.med-head>span{color:#aeb8d8}.med-drag{cursor:grab;color:#aebbe8;font-weight:700;user-select:none}.med-drag:active{cursor:grabbing}.med-collapse{border:0;border-radius:3px;background:#3a4265;color:#fff;cursor:pointer;font-size:16px;line-height:17px}.med-note{margin:4px 0;color:#aeb8d8}.med-hero{margin:7px 0;padding:8px;border:1px solid #58627f;border-radius:5px;background:#252b40}.med-hero-title{margin-bottom:6px;font-size:16px;font-weight:800}.med-hero strong,.med-hero span,.med-hero b{display:block}.med-hero span{margin:3px 0;color:#d6dbec}.med-warning{color:#ffd58b}.med-primary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.med-primary-grid>div{min-width:0;padding:6px;border-radius:4px;background:#1d2132}.med-primary-grid span,.med-primary-grid small{display:block;color:#aeb8d8}.med-primary-grid b{display:block;margin:1px 0;color:#fff;font-size:15px}.med-detail-grid{display:flex;flex-wrap:wrap;gap:4px 12px;margin:6px 0;color:#c8cee5}.med-detail-grid b{color:#fff}.med-bids{display:flex;flex-wrap:wrap;gap:3px 8px;margin-top:5px;color:#b7c2e5;font-size:11px}.med-bids span{white-space:nowrap}.med-details{margin-top:6px;padding-top:5px;border-top:1px solid #3a405c}@media(max-width:620px){.med-primary-grid{grid-template-columns:1fr}.med-head{align-items:flex-start;flex-direction:column;gap:1px}}
        </style>
        <div class="med-head"><div class="med-drag" data-role="float-drag-handle" title="拖动浮窗">⠿ <h4>强化停止 / 继续 EV</h4></div><span>${escapeRankingHtml(enhancementDecision.itemName)} · 当前 +${level} · 保护 +${protection} <button class="med-collapse" type="button" data-role="float-toggle" title="收起">−</button></span></div>
        ${decisionHtml}
        <div class="med-details">
          <div class="med-note">已记录（脚本加载后）：${enhancementDecision.actions} 次；成功 ${enhancementDecision.successes} / 失败 ${enhancementDecision.failures} / 跳级 ${enhancementDecision.leaps} / 保护消耗 ${enhancementDecision.protectionUses}（观测成功率 ${observedRate}，不参与 EV 概率计算）</div>
          <div>白板当前最低卖单：${whiteboardAsk > 0 ? formatDecisionMoney(whiteboardAsk) : "无卖单"}　${stopValue === null || whiteboardAsk <= 0 ? "本次实际停止盈亏无法估值" : `本次实际停止盈亏 ${formatDecisionMoney(actualPnl)}`}</div>
          <div class="med-note">本次盈亏按当前市场价估值：白板取左一卖单，材料/保护取当前可购买价；不计入未来 EV。</div>
          ${rates ? `<div>游戏当前概率：成功 ${(rates.success * 100).toFixed(2)}%（普通 ${(rates.normal * 100).toFixed(2)}%，跳级 ${(rates.leap * 100).toFixed(2)}%，失败 ${(rates.failure * 100).toFixed(2)}%）</div>` : ""}
          ${costModel.error ? `<div class="med-warning">${escapeRankingHtml(costModel.error)}</div>` : `<div class="med-note">单次材料 ${formatDecisionMoney(costModel.materialPerAction)}；保护道具 ${costModel.protectionHrid ? `${escapeRankingHtml(costModel.protectionHrid)} ${formatDecisionMoney(costModel.protectionPrice)}` : "当前保护起点不消耗"}。</div>`}
          ${futureHtml}
          <div class="med-note">递归策略：${policySummary}</div>
          <div class="med-bids">${bidLevels}</div>
        </div>`;
    }

    // ═══════════════════════════════════════════════
    //  WebSocket Hook（缓存市场数据）
    // ═══════════════════════════════════════════════

    let wsHookInstalled = false;

    function installWsHook() {
      if (wsHookInstalled) return;
      const descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
      if (!descriptor || typeof descriptor.get !== "function") return;
      const originalGetter = descriptor.get;

      Object.defineProperty(MessageEvent.prototype, "data", {
        ...descriptor,
        get: function () {
          const data = originalGetter.call(this);
          if (this.currentTarget instanceof WebSocket && typeof data === "string") {
            try {
              const msg = JSON.parse(data);
              if (msg?.type === "market_item_order_books_updated" && msg.marketItemOrderBooks) {
                updateMarketCacheFromWS(msg.marketItemOrderBooks);
                clearAllInserted();
                ensureEnhancementDecisionPanel();
              } else if (msg?.type === "action_completed") {
                handleEnhancementActionCompleted(msg);
              }
            } catch (_) {}
          }
          return data;
        }
      });
      wsHookInstalled = true;
    }

    // ═══════════════════════════════════════════════
    //  DOM Observer
    // ═══════════════════════════════════════════════

    let debounceTimer = null;

    function initObserver() {
      const observer = new MutationObserver((mutations) => {
        // 排行榜自己的进度文字和表格更新不属于游戏市场界面，跳过整页扫描。
        const onlyRankingUiChanged = mutations.length > 0 && mutations.every((mutation) => {
          const target = mutation.target?.nodeType === Node.ELEMENT_NODE
            ? mutation.target
            : mutation.target?.parentElement;
          return Boolean(target?.closest?.("#enhance-ranking-floating-overlay, #mwi-enhance-toolkit-button, #mwi-enhance-toolkit-menu, #mwi-enhance-decision-panel"));
        });
        if (onlyRankingUiChanged) return;
        if (debounceTimer) return;
        const schedule = typeof queueMicrotask === "function" ? queueMicrotask : (cb) => setTimeout(cb, 0);
        debounceTimer = true;
        schedule(() => {
          debounceTimer = null;
          try {
            insertOrderBooksInfo(document);
            ensureEnhancementDecisionPanel();
          } catch (e) {
            console.error("[HourlyRate]", e);
          }
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    // ═══════════════════════════════════════════════
    //  入口
    // ═══════════════════════════════════════════════

    async function init() {
      console.log("[MWI Enhance Helper] header toolbox ranking v1.11.0 loaded");
      injectTooltipStyle();
      document.addEventListener("click", hideTooltip);
      window.addEventListener("scroll", hideTooltip, true);
      window.addEventListener("resize", hideTooltip);
      // 工具箱按钮独立于游戏标签栏，锚定在玩家名字左侧。
      startHeaderToolkitIntegration();
      ensureEnhancementDecisionPanel();
      window.__MWI_PRIVATE_MARKET_PROMISE__ = window.__MWI_PRIVATE_MARKET_PROMISE__ || fetchMarketApi();
      await window.__MWI_PRIVATE_MARKET_PROMISE__;
      if (!legacyHourlyRateAlreadyRunning) {
        installWsHook();
        initObserver();
      }
      if (rankingUi.panel?.isConnected && rankingUi.overlay && !rankingUi.overlay.hidden && rankingUi.rows.length === 0) {
        calculateRanking(rankingUi.panel, true);
      }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
      setTimeout(init, 500);
    } else {
      document.addEventListener("DOMContentLoaded", () => setTimeout(init, 500));
    }
  })();
