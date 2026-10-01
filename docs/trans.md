# Pokemon Showdown 翻译与汉化方案

本文档详细记录 Pokemon Showdown 的翻译系统现状分析、汉化方案设计与实施指南。

---

## 目录

1. [系统架构概述](#1-系统架构概述)
2. [现有翻译系统分析](#2-现有翻译系统分析)
3. [油猴汉化脚本分析](#3-油猴汉化脚本分析)
4. [汉化方案对比](#4-汉化方案对比)
5. [推荐方案：客户端翻译层](#5-推荐方案客户端翻译层)
6. [数据提取与转换](#6-数据提取与转换)
7. [实施路径](#7-实施路径)
8. [附录](#8-附录)

---

## 1. 系统架构概述

### 1.1 Pokemon Showdown 整体架构

Pokemon Showdown 采用前后端分离的架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Pokemon Showdown 整体架构                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────┐      ┌─────────────────────────┐      │
│  │   服务端                 │      │   客户端                 │      │
│  │   pokemon-showdown      │◄────►│   pokemon-showdown-client│      │
│  │                         │      │                         │      │
│  │  ├─ server/             │      │  ├─ js/                  │      │
│  │  │  └─ 聊天、房间管理    │      │  │  ├─ battle.js        │      │
│  │  ├─ sim/                │      │  │  ├─ client.js         │      │
│  │  │  └─ 对战模拟器       │      │  │  └─ teambuilder.js    │      │
│  │  ├─ data/               │      │  ├─ data/                │      │
│  │  │  ├─ moves.ts         │      │  │  └─ (从服务端同步)     │      │
│  │  │  ├─ pokedex.ts       │      │  ├─ style/               │      │
│  │  │  ├─ abilities.ts     │      │  │  └─ CSS 样式          │      │
│  │  │  └─ items.ts         │      │  └─ index.html           │      │
│  │  └─ translations/       │      │                         │      │
│  │     └─ 聊天命令翻译      │      │                         │      │
│  └─────────────────────────┘      └─────────────────────────┘      │
│              │                              ▲                       │
│              │ WebSocket 协议               │                       │
│              │ (对战消息、聊天消息)          │                       │
│              └──────────────────────────────┘                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 数据流向

```
┌──────────────────────────────────────────────────────────────────────┐
│                         数据流向分析                                  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  服务端 data/                    协议消息                    客户端显示
│  ┌─────────────┐                                           ┌────────┐
│  │ moves.ts    │                                           │        │
│  │ earthquake: │    |move|p1a: Pikachu|Earthquake|p2a     │ 皮卡丘  │
│  │   name:     │──────────────────────────────────────────►│ 使用了 │
│  │ "Earthquake"│    (协议中使用英文 ID/名称)                │ 地震！ │
│  └─────────────┘                                           └────────┘
│                                                                ▲
│                                                                │
│                                                           翻译发生在
│                                                           客户端渲染时
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.3 关键认知

| 认知点 | 说明 |
|--------|------|
| **协议使用英文** | 服务端与客户端之间的协议消息始终使用英文名称/ID |
| **渲染在客户端** | 所有用户可见的文本渲染都在客户端完成 |
| **数据来源服务端** | 精灵、技能等游戏数据定义在服务端 `data/` 目录 |
| **翻译最佳位置** | 客户端渲染时进行翻译，不改变协议和数据结构 |

---

## 2. 现有翻译系统分析

### 2.1 服务端翻译系统

Pokemon Showdown 服务端有一套**聊天命令/UI 翻译系统**，但**不包含游戏数据翻译**。

#### 2.1.1 翻译文件位置

```
translations/
├── dutch/
├── french/
├── german/
├── hindi/
├── italian/
├── japanese/
├── portuguese/
├── simplifiedchinese/          # 简体中文
│   ├── helptickets.ts          # 帮助工单相关翻译
│   ├── main.ts                 # 主要 UI 文本翻译
│   └── minor-activities.ts     # 小活动翻译
├── spanish/
├── thai/
├── traditionalchinese/         # 繁体中文
│   ├── helptickets.ts
│   └── main.ts
└── vietnamese/
```

#### 2.1.2 翻译文件格式

```typescript
// translations/simplifiedchinese/main.ts
import type { Translations } from '../../server/chat';

export const translations: Translations = {
    name: "Simplified Chinese",
    strings: {
        // UI 文本翻译
        "namelocked": "用户名封锁",
        "locked": "用户封锁",
        "Please follow the rules:": "遵守规则:",
        "Global Rules": "全站规则",
        "${room} room rules": "${room}房间规则",  // 支持参数替换

        // 权限说明
        "+ <strong>Global Voice</strong> - They can use ! commands like !groups":
            "+ <strong>全服信任用户</strong> -可以使用!广播指令",

        // 指令帮助
        "/help OR /h OR /? - Gives you help.": "/help 或 /h 或 /? - 寻求帮助",

        // ... 更多翻译
    }
};
```

#### 2.1.3 翻译加载机制

翻译系统的核心实现位于 `server/chat.ts:1733-1821`：

```typescript
async loadTranslations() {
    const directories = await FS(TRANSLATION_DIRECTORY).readdir();

    // 确保英语是第一个条目
    Chat.languages.set('english' as ID, 'English');

    for (const dirname of directories) {
        if (/[^a-z0-9]/.test(dirname)) continue;

        const languageID = Dex.toID(dirname);
        const files = await dir.readdir();

        for (const filename of files) {
            if (!filename.endsWith('.js')) continue;

            const content: Translations = require(`${TRANSLATION_DIRECTORY}/${dirname}/${filename}`).translations;

            if (!Chat.translations.has(languageID)) {
                Chat.translations.set(languageID, new Map());
            }

            const translationsSoFar = Chat.translations.get(languageID)!;

            if (content.strings) {
                for (const key in content.strings) {
                    // 处理参数替换 ${...} 和翻译注释 [TN: ...]
                    const newKey = key.replace(/\${.+?}/g, str => {
                        keyLabels.push(str);
                        return '${}';
                    }).replace(/\[TN: ?.+?\]/g, '');

                    translationsSoFar.set(newKey, [val, keyLabels, valLabels]);
                }
            }
        }
    }
}
```

#### 2.1.4 翻译系统特性

| 特性 | 说明 |
|------|------|
| 动态参数替换 | 支持 `${variable}` 语法 |
| 翻译注释 | 支持 `[TN: 注释内容]` 给翻译者的说明 |
| 多文件分割 | 按功能模块分割翻译文件 |
| 缓存机制 | 加载后缓存到 `Chat.translations` |

#### 2.1.5 覆盖范围

| 内容类型 | 是否覆盖 | 说明 |
|----------|---------|------|
| 聊天指令帮助 | ✅ 是 | `/help` 等命令的输出 |
| 权限说明 | ✅ 是 | `/groups` 等 |
| 系统提示 | ✅ 是 | 连接、断开等提示 |
| **精灵名称** | ❌ 否 | 需要额外实现 |
| **技能名称** | ❌ 否 | 需要额外实现 |
| **特性名称** | ❌ 否 | 需要额外实现 |
| **道具名称** | ❌ 否 | 需要额外实现 |
| **技能描述** | ❌ 否 | 需要额外实现 |

### 2.2 游戏数据文本系统

游戏数据的描述文本存储在 `data/text/` 目录，**仅有英文**：

```
data/text/
├── abilities.ts    # 特性描述 (148 KB)
├── items.ts        # 道具描述 (80 KB)
├── moves.ts        # 技能描述 (536 KB)
└── pokedex.ts      # 精灵描述 (49 KB)
```

#### 2.2.1 数据格式示例

```typescript
// data/text/moves.ts
export const MovesText: {[k: string]: MoveText} = {
    earthquake: {
        name: "Earthquake",
        desc: "Damage is doubled if the target is using Dig.",
        shortDesc: "Hits adjacent Pokemon. 2x power on Dig.",
    },
    // ...
};
```

#### 2.2.2 加载机制

文本数据通过 `sim/dex.ts:261-301` 加载：

```typescript
// Dex 类中的文本加载
loadTextData() {
    // 加载各类文本数据
    this.data.AbilitiesText = require('../data/text/abilities').AbilitiesText;
    this.data.ItemsText = require('../data/text/items').ItemsText;
    this.data.MovesText = require('../data/text/moves').MovesText;
    this.data.PokedexText = require('../data/text/pokedex').PokedexText;
}
```

### 2.3 小结：现有系统的局限性

```
┌────────────────────────────────────────────────────────────────────┐
│                      翻译系统覆盖范围                               │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────────────────┐  ┌─────────────────────────┐         │
│  │     已有翻译 ✅          │  │     缺失翻译 ❌          │         │
│  │                         │  │                         │         │
│  │  • 聊天指令帮助          │  │  • 精灵名称              │         │
│  │  • 权限说明              │  │  • 技能名称              │         │
│  │  • 系统提示              │  │  • 特性名称              │         │
│  │  • 房间规则              │  │  • 道具名称              │         │
│  │                         │  │  • 技能/特性/道具描述    │         │
│  │                         │  │  • 对战日志文本          │         │
│  │                         │  │  • Teambuilder UI       │         │
│  └─────────────────────────┘  └─────────────────────────┘         │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 3. 油猴汉化脚本分析

### 3.1 脚本概述

项目中存在一个油猴汉化脚本 `Translation.js`，来自 PSChina 社区：

| 属性 | 值 |
|------|-----|
| 名称 | PSChina Server Translation SV |
| 版本 | 1.7.2 |
| 作者 | AL、WyAK |
| 代码行数 | ~12,000 行 |
| 依赖 | jQuery 3.7.1 |

### 3.2 脚本结构

```javascript
// ==UserScript==
// @name         PSChina Server Translation SV
// @namespace    http://tampermonkey.net/
// @version      1.7.2
// @match        *://china.psim.us/*
// @match        *://play.pokemonshowdown.com/*
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @run-at       document-end
// ==/UserScript==

// 1. 翻译字典 (第 20-7198 行)
var translations = {
    // 系统 UI
    "Connecting...": "连接中...",
    "Loading...": "加载中...",

    // 精灵名称
    "Bulbasaur": "妙蛙种子",
    "Ivysaur": "妙蛙草",
    // ...

    // 技能名称
    "Earthquake": "地震",
    "Thunderbolt": "十万伏特",
    // ...

    // 特性名称
    "Overgrow": "茂盛",
    "Blaze": "猛火",
    // ...

    // 道具名称
    "Leftovers": "吃剩的东西",
    // ...
};

// 2. 特殊翻译函数 (第 7199-8321 行)
function trans_from_dict(a) {
    // 处理特殊格式的翻译
}

// 3. 主翻译函数 (第 8322-11675 行)
var t = function (originalStr) {
    // 字典查询
    if (translations[originalStr]) {
        return translations[originalStr];
    }

    // 特殊文本处理（长描述等）
    if (originalStr.startsWith("For 5 turns, the terrain becomes...")) {
        return "5回合内，场地变为...";
    }

    // 正则替换处理
    return originalStr.replace(...);
};

// 4. DOM 翻译函数 (第 11676-11974 行)
function translateNode(node) {
    if (node.tagName == 'SCRIPT') return;
    var value = node.nodeValue;
    // 特殊长文本匹配
    if (value.startsWith("If this move is successful...")) {
        node.nodeValue = "如果招式成功...";
    }
    // ...
}

function translateElement(element) {
    // 遍历元素的所有文本节点
    var walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null,
        false
    );
    while (walker.nextNode()) {
        translateNode(walker.currentNode);
    }
}

// 5. MutationObserver 实时翻译 (第 11975-11996 行)
(function() {
    const observerCallback = function(mutationsList, observer) {
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        translateElement(node);
                    }
                });
            }
        }
    };

    const observer = new MutationObserver(observerCallback);
    observer.observe(document.body, { childList: true, subtree: true });

    // 初始翻译
    translateElement(document.body);
})();
```

### 3.3 翻译数据统计

通过分析脚本，翻译覆盖的数据量：

| 类型 | 数量 (估计) | 示例 |
|------|------------|------|
| 精灵名称 | ~1000+ | Bulbasaur → 妙蛙种子 |
| 技能名称 | ~900+ | Earthquake → 地震 |
| 特性名称 | ~300+ | Overgrow → 茂盛 |
| 道具名称 | ~400+ | Leftovers → 吃剩的东西 |
| UI 文本 | ~500+ | Loading... → 加载中... |
| 技能描述 | ~200+ | 长文本特殊处理 |

### 3.4 翻译实现机制

```
┌─────────────────────────────────────────────────────────────────────┐
│                    油猴脚本翻译流程                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  页面加载完成                                                        │
│       │                                                             │
│       ▼                                                             │
│  ┌─────────────────────┐                                           │
│  │ 初始翻译             │                                           │
│  │ translateElement    │                                           │
│  │ (document.body)     │                                           │
│  └──────────┬──────────┘                                           │
│             │                                                       │
│             ▼                                                       │
│  ┌─────────────────────┐      ┌─────────────────────┐              │
│  │ MutationObserver    │      │ 翻译字典查询         │              │
│  │ 监听 DOM 变化        │─────►│ translations[key]   │              │
│  └──────────┬──────────┘      └──────────┬──────────┘              │
│             │                            │                          │
│             │ 新节点添加                   │ 返回中文                 │
│             ▼                            ▼                          │
│  ┌─────────────────────┐      ┌─────────────────────┐              │
│  │ translateNode       │      │ 更新 DOM 文本        │              │
│  │ 遍历文本节点         │─────►│ node.nodeValue = zh │              │
│  └─────────────────────┘      └─────────────────────┘              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.5 优缺点分析

#### 优点

| 优点 | 说明 |
|------|------|
| **完整的翻译数据** | 覆盖精灵、技能、特性、道具、UI |
| **零服务端改动** | 纯前端方案，不影响服务端 |
| **社区维护** | PSChina 社区持续更新 |
| **实时翻译** | MutationObserver 监听新内容 |
| **兼容性好** | 适用于多个 PS 服务器 |

#### 缺点

| 缺点 | 说明 |
|------|------|
| **依赖 jQuery** | 增加额外依赖 |
| **用户需安装** | 每个用户都要装油猴插件 |
| **性能开销** | DOM 遍历和文本替换有开销 |
| **维护分散** | 翻译更新需要用户重新安装 |
| **长文本硬编码** | 技能描述用 startsWith 匹配，脆弱 |

### 3.6 可复用价值

| 价值点 | 说明 |
|--------|------|
| **翻译字典** | 可直接提取使用 |
| **特殊文本处理** | 长描述的翻译可参考 |
| **翻译覆盖范围** | 作为完整性参考 |

---

## 4. 汉化方案对比

### 4.1 方案概览

| 方案 | 改动位置 | 复杂度 | 维护成本 | 用户体验 | 推荐度 |
|------|---------|--------|---------|---------|--------|
| A. 客户端翻译层 | 客户端 | 中 | 低 | 好 | ⭐⭐⭐⭐⭐ |
| B. 服务端数据修改 | 服务端 data/ | 高 | 高 | 好 | ⭐⭐ |
| C. 协议层翻译 | 服务端协议 | 高 | 高 | 好 | ⭐⭐ |
| D. 油猴脚本 | 用户浏览器 | 低 | 低 | 一般 | ⭐⭐⭐ |

### 4.2 方案 A: 客户端翻译层（推荐）

#### 4.2.1 核心思路

在客户端渲染时进行翻译，不改变协议和数据结构。

```
┌─────────────────────────────────────────────────────────────────────┐
│                      方案 A: 客户端翻译层                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  服务端                        客户端                                │
│  ┌─────────────┐              ┌─────────────────────────────────┐  │
│  │             │              │                                 │  │
│  │  data/      │   协议消息   │  ┌─────────────────────────┐   │  │
│  │  moves.ts   │─────────────►│  │ js/translations/zh-CN.js│   │  │
│  │             │  Earthquake  │  │                         │   │  │
│  │             │              │  │ BattleTranslations = {  │   │  │
│  │             │              │  │   moves: {              │   │  │
│  │             │              │  │     "Earthquake": "地震" │   │  │
│  │             │              │  │   }                     │   │  │
│  │             │              │  │ }                       │   │  │
│  │             │              │  └───────────┬─────────────┘   │  │
│  │             │              │              │                 │  │
│  │             │              │              ▼                 │  │
│  │             │              │  ┌─────────────────────────┐   │  │
│  │             │              │  │ BattleI18n.move(name)   │   │  │
│  │             │              │  │ → "地震"                 │   │  │
│  │             │              │  └───────────┬─────────────┘   │  │
│  │             │              │              │                 │  │
│  │             │              │              ▼                 │  │
│  │             │              │  ┌─────────────────────────┐   │  │
│  │             │              │  │ 渲染: "皮卡丘使用了地震" │   │  │
│  │             │              │  └─────────────────────────┘   │  │
│  │             │              │                                 │  │
│  └─────────────┘              └─────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

#### 4.2.2 优点

- 不改变服务端代码和协议
- 翻译数据集中管理
- 便于支持多语言切换
- 回放和导出仍使用英文（兼容性好）

#### 4.2.3 缺点

- 需要 fork 和维护客户端
- 需要找到所有渲染点进行修改

### 4.3 方案 B: 服务端数据修改

#### 4.3.1 核心思路

直接修改 `data/*.ts` 中的 `name` 字段。

```typescript
// data/moves.ts (修改前)
earthquake: {
    name: "Earthquake",
    // ...
}

// data/moves.ts (修改后)
earthquake: {
    name: "地震",  // 直接改为中文
    // ...
}
```

#### 4.3.2 问题

| 问题 | 说明 |
|------|------|
| **ID 不一致** | `earthquake` ID 与 `地震` name 不匹配 |
| **协议混乱** | 协议消息中出现中文，影响解析 |
| **合并冲突** | 上游更新时大量冲突 |
| **回放兼容** | 旧回放可能无法播放 |

#### 4.3.3 结论

**不推荐**，除非完全放弃跟踪上游更新。

### 4.4 方案 C: 协议层翻译

#### 4.4.1 核心思路

在服务端发送协议消息时进行翻译。

```typescript
// sim/battle.ts
addMove(action, pokemon, move, target) {
    const translatedMove = this.translateMove(move);  // 新增翻译
    this.log.push(`|move|${pokemon}|${translatedMove}|${target}`);
}
```

#### 4.4.2 问题

| 问题 | 说明 |
|------|------|
| **协议破坏** | 标准协议被修改，第三方工具可能失效 |
| **回放问题** | 回放数据包含中文，兼容性差 |
| **性能开销** | 每条消息都需要翻译查询 |
| **多语言困难** | 服务端难以知道每个用户的语言偏好 |

#### 4.4.3 结论

**不推荐**，对核心协议的修改风险太高。

### 4.5 方案 D: 油猴脚本

#### 4.5.1 核心思路

保持现有油猴脚本方案，让用户自行安装。

#### 4.5.2 适用场景

- 快速验证翻译效果
- 用户群体较小
- 不想维护自定义客户端

#### 4.5.3 问题

- 用户需要手动安装
- 翻译更新需要用户重新安装
- 依赖 jQuery

---

## 5. 推荐方案：客户端翻译层

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    客户端翻译层架构                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  pokemon-showdown-client/                                           │
│  │                                                                  │
│  ├─ js/                                                             │
│  │  ├─ i18n/                          # 新增：国际化模块             │
│  │  │  ├─ index.js                    # 翻译入口                    │
│  │  │  ├─ zh-CN/                      # 简体中文                    │
│  │  │  │  ├─ pokemon.js               # 精灵名称                    │
│  │  │  │  ├─ moves.js                 # 技能名称                    │
│  │  │  │  ├─ abilities.js             # 特性名称                    │
│  │  │  │  ├─ items.js                 # 道具名称                    │
│  │  │  │  ├─ types.js                 # 属性名称                    │
│  │  │  │  ├─ natures.js               # 性格名称                    │
│  │  │  │  └─ ui.js                    # UI 文本                     │
│  │  │  └─ zh-TW/                      # 繁体中文（可选）            │
│  │  │                                                               │
│  │  ├─ battle.js                      # 修改：添加翻译调用           │
│  │  ├─ battle-tooltips.js             # 修改：添加翻译调用           │
│  │  ├─ client-teambuilder.js          # 修改：添加翻译调用           │
│  │  └─ ...                                                          │
│  │                                                                  │
│  └─ index.html                        # 修改：加载翻译模块           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 翻译数据结构

#### 5.2.1 主入口 `js/i18n/index.js`

```javascript
/**
 * Pokemon Showdown 国际化模块
 *
 * 使用方法:
 *   BattleI18n.pokemon('Pikachu')     → '皮卡丘'
 *   BattleI18n.move('Earthquake')     → '地震'
 *   BattleI18n.ability('Overgrow')    → '茂盛'
 *   BattleI18n.item('Leftovers')      → '吃剩的东西'
 *   BattleI18n.type('Electric')       → '电'
 *   BattleI18n.nature('Adamant')      → '固执'
 *   BattleI18n.ui('Loading...')       → '加载中...'
 */

const BattleI18n = (function() {
    'use strict';

    // 当前语言
    let currentLang = 'zh-CN';

    // 翻译数据缓存
    let translations = null;

    // 加载翻译数据
    function loadTranslations(lang) {
        currentLang = lang;

        // 根据语言加载对应的翻译文件
        switch (lang) {
            case 'zh-CN':
                translations = {
                    pokemon: window.BattleTranslations_zhCN_Pokemon || {},
                    moves: window.BattleTranslations_zhCN_Moves || {},
                    abilities: window.BattleTranslations_zhCN_Abilities || {},
                    items: window.BattleTranslations_zhCN_Items || {},
                    types: window.BattleTranslations_zhCN_Types || {},
                    natures: window.BattleTranslations_zhCN_Natures || {},
                    ui: window.BattleTranslations_zhCN_UI || {}
                };
                break;
            case 'zh-TW':
                // 繁体中文
                break;
            default:
                translations = null;
        }
    }

    // 通用翻译函数
    function translate(category, name) {
        if (!translations || !translations[category]) {
            return name;
        }
        return translations[category][name] || name;
    }

    // 公开 API
    return {
        // 初始化
        init: function(lang) {
            loadTranslations(lang || 'zh-CN');
        },

        // 获取/设置当前语言
        get lang() { return currentLang; },
        set lang(value) { loadTranslations(value); },

        // 翻译函数
        pokemon: function(name) { return translate('pokemon', name); },
        move: function(name) { return translate('moves', name); },
        ability: function(name) { return translate('abilities', name); },
        item: function(name) { return translate('items', name); },
        type: function(name) { return translate('types', name); },
        nature: function(name) { return translate('natures', name); },
        ui: function(text) { return translate('ui', text); },

        // 通用翻译（自动检测类型）
        t: function(category, name) { return translate(category, name); }
    };
})();

// 页面加载时初始化
if (typeof window !== 'undefined') {
    window.BattleI18n = BattleI18n;

    // 检测用户语言偏好
    const userLang = localStorage.getItem('pokemon-showdown-lang') ||
                     navigator.language ||
                     'en';

    if (userLang.startsWith('zh')) {
        BattleI18n.init(userLang.includes('TW') || userLang.includes('HK') ? 'zh-TW' : 'zh-CN');
    }
}
```

#### 5.2.2 精灵名称 `js/i18n/zh-CN/pokemon.js`

```javascript
/**
 * 精灵名称翻译 - 简体中文
 *
 * 数据来源: PSChina Translation.js
 * 格式: { "英文名": "中文名" }
 */

window.BattleTranslations_zhCN_Pokemon = {
    // 第一世代
    "Bulbasaur": "妙蛙种子",
    "Ivysaur": "妙蛙草",
    "Venusaur": "妙蛙花",
    "Charmander": "小火龙",
    "Charmeleon": "火恐龙",
    "Charizard": "喷火龙",
    "Squirtle": "杰尼龟",
    "Wartortle": "卡咪龟",
    "Blastoise": "水箭龟",
    "Caterpie": "绿毛虫",
    "Metapod": "铁甲蛹",
    "Butterfree": "巴大蝶",
    "Weedle": "独角虫",
    "Kakuna": "铁壳蛹",
    "Beedrill": "大针蜂",
    "Pidgey": "波波",
    "Pidgeotto": "比比鸟",
    "Pidgeot": "大比鸟",
    "Rattata": "小拉达",
    "Raticate": "拉达",
    "Spearow": "烈雀",
    "Fearow": "大嘴雀",
    "Ekans": "阿柏蛇",
    "Arbok": "阿柏怪",
    "Pikachu": "皮卡丘",
    "Raichu": "雷丘",
    // ... 更多精灵

    // 地区形态
    "Rattata-Alola": "小拉达-阿罗拉",
    "Raticate-Alola": "拉达-阿罗拉",
    "Pikachu-Original": "皮卡丘-初始",
    "Pikachu-Partner": "皮卡丘-搭档",
    // ... 更多形态

    // 超级进化
    "Venusaur-Mega": "妙蛙花-超级",
    "Charizard-Mega-X": "喷火龙-超级X",
    "Charizard-Mega-Y": "喷火龙-超级Y",
    "Blastoise-Mega": "水箭龟-超级",
    // ... 更多超级进化
};
```

#### 5.2.3 技能名称 `js/i18n/zh-CN/moves.js`

```javascript
/**
 * 技能名称翻译 - 简体中文
 */

window.BattleTranslations_zhCN_Moves = {
    // A
    "Absorb": "吸取",
    "Accelerock": "冲岩",
    "Acid": "溶解液",
    "Acid Armor": "溶化",
    "Acid Spray": "酸液炸弹",
    "Acrobatics": "杂技",
    "Acupressure": "点穴",
    "Aerial Ace": "燕返",
    "Aeroblast": "气旋攻击",
    "After You": "您先请",
    "Agility": "高速移动",
    "Air Cutter": "空气利刃",
    "Air Slash": "空气斩",
    // ...

    // E
    "Earthquake": "地震",
    "Earth Power": "大地之力",
    "Echoed Voice": "回声",
    // ...

    // T
    "Tackle": "撞击",
    "Tail Whip": "摇尾巴",
    "Take Down": "猛撞",
    "Teleport": "瞬间移动",
    "Thunder": "打雷",
    "Thunderbolt": "十万伏特",
    "Thunder Wave": "电磁波",
    // ...
};
```

#### 5.2.4 特性名称 `js/i18n/zh-CN/abilities.js`

```javascript
/**
 * 特性名称翻译 - 简体中文
 */

window.BattleTranslations_zhCN_Abilities = {
    "Adaptability": "适应力",
    "Aerilate": "飞行皮肤",
    "Aftermath": "引爆",
    "Air Lock": "气闸",
    "Analytic": "分析",
    "Anger Point": "愤怒穴位",
    "Anticipation": "危险预知",
    "Arena Trap": "沙穴",
    "Aroma Veil": "芳香幕",
    "As One": "人马一体",
    // ...

    "Blaze": "猛火",
    "Bulletproof": "防弹",
    // ...

    "Overgrow": "茂盛",
    // ...

    "Torrent": "激流",
    // ...
};
```

#### 5.2.5 道具名称 `js/i18n/zh-CN/items.js`

```javascript
/**
 * 道具名称翻译 - 简体中文
 */

window.BattleTranslations_zhCN_Items = {
    // 携带道具
    "Leftovers": "吃剩的东西",
    "Choice Band": "讲究头带",
    "Choice Scarf": "讲究围巾",
    "Choice Specs": "讲究眼镜",
    "Life Orb": "生命宝珠",
    "Focus Sash": "气势披带",
    "Eviolite": "进化奇石",
    "Assault Vest": "突击背心",
    "Rocky Helmet": "凹凸头盔",
    "Heavy-Duty Boots": "厚底靴",
    // ...

    // 树果
    "Oran Berry": "橙橙果",
    "Sitrus Berry": "文柚果",
    "Lum Berry": "奇迹果",
    "Chesto Berry": "零余果",
    // ...

    // 宝石
    "Normal Gem": "一般宝石",
    "Fire Gem": "火宝石",
    "Water Gem": "水宝石",
    // ...
};
```

#### 5.2.6 属性名称 `js/i18n/zh-CN/types.js`

```javascript
/**
 * 属性名称翻译 - 简体中文
 */

window.BattleTranslations_zhCN_Types = {
    "Normal": "一般",
    "Fire": "火",
    "Water": "水",
    "Electric": "电",
    "Grass": "草",
    "Ice": "冰",
    "Fighting": "格斗",
    "Poison": "毒",
    "Ground": "地面",
    "Flying": "飞行",
    "Psychic": "超能力",
    "Bug": "虫",
    "Rock": "岩石",
    "Ghost": "幽灵",
    "Dragon": "龙",
    "Dark": "恶",
    "Steel": "钢",
    "Fairy": "妖精"
};
```

#### 5.2.7 性格名称 `js/i18n/zh-CN/natures.js`

```javascript
/**
 * 性格名称翻译 - 简体中文
 */

window.BattleTranslations_zhCN_Natures = {
    "Hardy": "勤奋",
    "Lonely": "怕寂寞",
    "Brave": "勇敢",
    "Adamant": "固执",
    "Naughty": "顽皮",
    "Bold": "大胆",
    "Docile": "坦率",
    "Relaxed": "悠闲",
    "Impish": "淘气",
    "Lax": "乐天",
    "Timid": "胆小",
    "Hasty": "急躁",
    "Serious": "认真",
    "Jolly": "爽朗",
    "Naive": "天真",
    "Modest": "内敛",
    "Mild": "慢吞吞",
    "Quiet": "冷静",
    "Bashful": "害羞",
    "Rash": "马虎",
    "Calm": "温和",
    "Gentle": "温顺",
    "Sassy": "自大",
    "Careful": "慎重",
    "Quirky": "浮躁"
};
```

#### 5.2.8 UI 文本 `js/i18n/zh-CN/ui.js`

```javascript
/**
 * UI 文本翻译 - 简体中文
 */

window.BattleTranslations_zhCN_UI = {
    // 连接状态
    "Connecting...": "连接中...",
    "Loading...": "加载中...",
    "Searching...": "搜索中...",
    "Disconnected": "已断开连接",
    "Reconnect": "重新连接",

    // 主页
    "Home": "主页",
    "Teambuilder": "队伍编辑器",
    "Ladder": "排行榜",
    "Battle!": "战斗！",
    "Watch a battle": "观看对战",
    "Find a user": "查找用户",

    // 对战
    "What will you do?": "你要怎么做？",
    "Fight": "战斗",
    "Switch": "换人",
    "Moves": "招式",
    "Cancel": "取消",
    "Mega Evolution": "超级进化",
    "Z-Move": "Z招式",
    "Dynamax": "极巨化",
    "Terastallize": "太晶化",

    // 对战日志
    "Turn": "回合",
    "fainted": "倒下了",
    "sent out": "派出了",
    "used": "使用了",
    "It's super effective!": "效果拔群！",
    "It's not very effective...": "效果不理想...",
    "It had no effect!": "没有效果！",
    "A critical hit!": "击中了要害！",

    // Teambuilder
    "New Team": "新队伍",
    "Import": "导入",
    "Export": "导出",
    "Validate": "验证",
    "Pokemon": "宝可梦",
    "Add Pokemon": "添加宝可梦",
    "Item": "道具",
    "Ability": "特性",
    "Moves": "招式",
    "Stats": "能力值",
    "EVs": "努力值",
    "IVs": "个体值",
    "Nature": "性格",
    "Level": "等级",
    "Gender": "性别",
    "Shiny": "闪光",

    // 更多...
};
```

### 5.3 客户端修改点

#### 5.3.1 `index.html` 加载翻译模块

```html
<!-- 在其他 JS 之前加载翻译数据 -->
<script src="js/i18n/zh-CN/pokemon.js"></script>
<script src="js/i18n/zh-CN/moves.js"></script>
<script src="js/i18n/zh-CN/abilities.js"></script>
<script src="js/i18n/zh-CN/items.js"></script>
<script src="js/i18n/zh-CN/types.js"></script>
<script src="js/i18n/zh-CN/natures.js"></script>
<script src="js/i18n/zh-CN/ui.js"></script>
<script src="js/i18n/index.js"></script>
```

#### 5.3.2 `js/battle.js` 对战显示

```javascript
// 原代码
this.message(`${pokemon.name} used ${move.name}!`);

// 修改为
this.message(`${BattleI18n.pokemon(pokemon.name)} 使用了 ${BattleI18n.move(move.name)}！`);
```

```javascript
// 原代码
this.message(`${pokemon.name} fainted!`);

// 修改为
this.message(`${BattleI18n.pokemon(pokemon.name)} ${BattleI18n.ui('fainted')}！`);
```

#### 5.3.3 `js/battle-tooltips.js` 技能提示

```javascript
// 原代码
text += `<strong>${move.name}</strong>`;

// 修改为
text += `<strong>${BattleI18n.move(move.name)}</strong>`;
```

#### 5.3.4 `js/client-teambuilder.js` 队伍编辑器

```javascript
// 原代码
pokemonName.textContent = set.species;

// 修改为
pokemonName.textContent = BattleI18n.pokemon(set.species);
```

### 5.4 关键渲染点清单

| 文件 | 功能 | 需要翻译的内容 |
|------|------|---------------|
| `js/battle.js` | 对战逻辑 | 精灵名、技能名、对战日志 |
| `js/battle-tooltips.js` | 悬浮提示 | 技能描述、特性描述、道具描述 |
| `js/battle-dex.js` | 数据查询 | 精灵名、技能名、特性名、道具名 |
| `js/battle-dex-search.js` | 搜索功能 | 搜索结果显示 |
| `js/client-teambuilder.js` | 队伍编辑器 | 精灵名、技能名、特性名、道具名、属性名 |
| `js/client-mainmenu.js` | 主菜单 | UI 文本 |
| `js/client-chat.js` | 聊天 | 系统消息 |
| `js/client-rooms.js` | 房间 | 房间名、规则 |

---

## 6. 数据提取与转换

### 6.1 从油猴脚本提取翻译数据

#### 6.1.1 提取脚本

```javascript
// extract-translations.js
// 从 Translation.js 提取翻译数据并分类

const fs = require('fs');
const path = require('path');

// 读取油猴脚本
const scriptContent = fs.readFileSync('Translation.js', 'utf-8');

// 提取 translations 对象
// 使用正则匹配 var translations = { ... };
const translationsMatch = scriptContent.match(/var translations = \{([\s\S]*?)\n\};/);

if (!translationsMatch) {
    console.error('无法找到 translations 对象');
    process.exit(1);
}

// 解析翻译数据
// 注意：这里使用 eval 是因为油猴脚本的格式不是标准 JSON
let translations;
try {
    translations = eval(`({${translationsMatch[1]}})`);
} catch (e) {
    console.error('解析翻译数据失败:', e);
    process.exit(1);
}

console.log(`提取到 ${Object.keys(translations).length} 条翻译`);

// 加载 PS 的 Dex 数据用于分类
// 需要先构建 pokemon-showdown: npm run build
const { Dex } = require('./dist/sim');

// 分类结果
const result = {
    pokemon: {},
    moves: {},
    abilities: {},
    items: {},
    types: {},
    natures: {},
    ui: {}
};

// 属性列表
const TYPES = [
    'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice',
    'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
    'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'
];

// 性格列表
const NATURES = [
    'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty',
    'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
    'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive',
    'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
    'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'
];

// 分类每条翻译
for (const [en, zh] of Object.entries(translations)) {
    // 跳过空翻译
    if (!zh || zh === en) continue;

    // 检查是否是属性
    if (TYPES.includes(en)) {
        result.types[en] = zh;
        continue;
    }

    // 检查是否是性格
    if (NATURES.includes(en)) {
        result.natures[en] = zh;
        continue;
    }

    // 包含空格或特殊字符的通常是 UI 文本
    if (en.includes(' ') || en.includes(':') || en.includes('!') || en.includes('?')) {
        result.ui[en] = zh;
        continue;
    }

    // 尝试匹配精灵
    const species = Dex.species.get(en);
    if (species.exists) {
        result.pokemon[en] = zh;
        continue;
    }

    // 尝试匹配技能
    const move = Dex.moves.get(en);
    if (move.exists) {
        result.moves[en] = zh;
        continue;
    }

    // 尝试匹配特性
    const ability = Dex.abilities.get(en);
    if (ability.exists) {
        result.abilities[en] = zh;
        continue;
    }

    // 尝试匹配道具
    const item = Dex.items.get(en);
    if (item.exists) {
        result.items[en] = zh;
        continue;
    }

    // 无法分类的归入 UI
    result.ui[en] = zh;
}

// 统计
console.log('\n分类统计:');
console.log(`  精灵: ${Object.keys(result.pokemon).length}`);
console.log(`  技能: ${Object.keys(result.moves).length}`);
console.log(`  特性: ${Object.keys(result.abilities).length}`);
console.log(`  道具: ${Object.keys(result.items).length}`);
console.log(`  属性: ${Object.keys(result.types).length}`);
console.log(`  性格: ${Object.keys(result.natures).length}`);
console.log(`  UI: ${Object.keys(result.ui).length}`);

// 输出目录
const outputDir = 'extracted-translations';
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 生成 JS 文件
function generateJSFile(category, data, filename) {
    const content = `/**
 * ${filename} - 简体中文
 * 自动从 Translation.js 提取
 * 生成时间: ${new Date().toISOString()}
 */

window.BattleTranslations_zhCN_${category} = ${JSON.stringify(data, null, 4)};
`;

    fs.writeFileSync(path.join(outputDir, `${filename}.js`), content);
    console.log(`生成: ${filename}.js`);
}

generateJSFile('Pokemon', result.pokemon, 'pokemon');
generateJSFile('Moves', result.moves, 'moves');
generateJSFile('Abilities', result.abilities, 'abilities');
generateJSFile('Items', result.items, 'items');
generateJSFile('Types', result.types, 'types');
generateJSFile('Natures', result.natures, 'natures');
generateJSFile('UI', result.ui, 'ui');

// 同时输出 JSON 格式（备份）
fs.writeFileSync(
    path.join(outputDir, 'translations-zh-CN.json'),
    JSON.stringify(result, null, 2)
);
console.log('\n生成: translations-zh-CN.json');

console.log('\n提取完成！');
```

#### 6.1.2 运行提取

```bash
# 确保已构建 PS
npm run build

# 运行提取脚本
node extract-translations.js
```

### 6.2 从 tmp_chinese 目录提取

项目中还有 `tmp_chinese/` 目录包含 Wiki 格式的翻译数据：

```
tmp_chinese/
├── ability.txt    # 特性翻译
├── move.txt       # 技能翻译
└── name.txt       # 精灵名称翻译
```

#### 6.2.1 解析 Wiki 格式

```javascript
// parse-wiki-translations.js
// 解析 tmp_chinese 目录中的 Wiki 格式翻译

const fs = require('fs');

// 解析精灵名称 (name.txt)
function parsePokemonNames(content) {
    const result = {};

    // 匹配 {{Rdexn|编号|中文名|日文名|英文名|...}}
    const regex = /\{\{Rdexn\|(\d+)\|([^|]+)\|[^|]+\|([^|]+)\|/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const [_, num, zhName, enName] = match;
        result[enName] = zhName;
    }

    return result;
}

// 解析技能名称 (move.txt)
function parseMoveNames(content) {
    const result = {};

    // 根据实际格式调整正则
    // 假设格式: |英文名|中文名|
    const regex = /\|([A-Za-z\s-]+)\|([^\|]+)\|/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const [_, enName, zhName] = match;
        if (enName && zhName) {
            result[enName.trim()] = zhName.trim();
        }
    }

    return result;
}

// 解析特性名称 (ability.txt)
function parseAbilityNames(content) {
    const result = {};

    // 根据实际格式调整正则
    const regex = /\|([A-Za-z\s-]+)\|([^\|]+)\|/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
        const [_, enName, zhName] = match;
        if (enName && zhName) {
            result[enName.trim()] = zhName.trim();
        }
    }

    return result;
}

// 主程序
const nameContent = fs.readFileSync('tmp_chinese/name.txt', 'utf-8');
const moveContent = fs.readFileSync('tmp_chinese/move.txt', 'utf-8');
const abilityContent = fs.readFileSync('tmp_chinese/ability.txt', 'utf-8');

const pokemon = parsePokemonNames(nameContent);
const moves = parseMoveNames(moveContent);
const abilities = parseAbilityNames(abilityContent);

console.log(`精灵: ${Object.keys(pokemon).length}`);
console.log(`技能: ${Object.keys(moves).length}`);
console.log(`特性: ${Object.keys(abilities).length}`);

// 输出
fs.writeFileSync('wiki-translations.json', JSON.stringify({
    pokemon,
    moves,
    abilities
}, null, 2));
```

### 6.3 合并多个数据源

```javascript
// merge-translations.js
// 合并不同来源的翻译数据

const fs = require('fs');

// 加载各来源的翻译
const oilMonkey = require('./extracted-translations/translations-zh-CN.json');
const wiki = require('./wiki-translations.json');

// 合并策略: 油猴脚本优先（更完整、更新）
const merged = {
    pokemon: { ...wiki.pokemon, ...oilMonkey.pokemon },
    moves: { ...wiki.moves, ...oilMonkey.moves },
    abilities: { ...wiki.abilities, ...oilMonkey.abilities },
    items: oilMonkey.items,
    types: oilMonkey.types,
    natures: oilMonkey.natures,
    ui: oilMonkey.ui
};

// 输出合并结果
fs.writeFileSync('merged-translations.json', JSON.stringify(merged, null, 2));

console.log('合并完成！');
console.log(`精灵: ${Object.keys(merged.pokemon).length}`);
console.log(`技能: ${Object.keys(merged.moves).length}`);
console.log(`特性: ${Object.keys(merged.abilities).length}`);
console.log(`道具: ${Object.keys(merged.items).length}`);
```

---

## 7. 实施路径

### 7.1 阶段划分

```
┌─────────────────────────────────────────────────────────────────────┐
│                        实施路径                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Phase 1: 数据准备 (1-2 天)                                          │
│  ├─ 从油猴脚本提取翻译数据                                           │
│  ├─ 从 tmp_chinese 提取补充数据                                      │
│  ├─ 合并并去重                                                       │
│  └─ 验证翻译覆盖率                                                   │
│                                                                     │
│  Phase 2: 客户端 Fork (0.5 天)                                       │
│  ├─ Fork pokemon-showdown-client                                    │
│  ├─ 设置本地开发环境                                                 │
│  └─ 验证客户端可正常构建                                             │
│                                                                     │
│  Phase 3: 翻译模块实现 (2-3 天)                                      │
│  ├─ 创建 i18n 目录结构                                               │
│  ├─ 实现 BattleI18n 核心模块                                         │
│  ├─ 添加翻译数据文件                                                 │
│  └─ 测试翻译函数                                                     │
│                                                                     │
│  Phase 4: 客户端改造 (3-5 天)                                        │
│  ├─ 修改 battle.js (对战显示)                                        │
│  ├─ 修改 battle-tooltips.js (悬浮提示)                               │
│  ├─ 修改 client-teambuilder.js (队伍编辑器)                          │
│  ├─ 修改其他相关文件                                                 │
│  └─ 测试所有修改点                                                   │
│                                                                     │
│  Phase 5: 集成测试 (1-2 天)                                          │
│  ├─ Teambuilder 完整流程测试                                         │
│  ├─ 对战完整流程测试                                                 │
│  ├─ 图鉴页面测试                                                     │
│  ├─ 移动端兼容性测试                                                 │
│  └─ 修复发现的问题                                                   │
│                                                                     │
│  Phase 6: 部署上线 (0.5-1 天)                                        │
│  ├─ 构建生产版本                                                     │
│  ├─ 配置服务端使用自定义客户端                                       │
│  ├─ 部署并监控                                                       │
│  └─ 收集用户反馈                                                     │
│                                                                     │
│  总计: 8-14 天                                                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 详细步骤

#### Phase 1: 数据准备

```bash
# 1. 创建工作目录
mkdir -p translation-work
cd translation-work

# 2. 复制油猴脚本
cp ../Translation.js .

# 3. 运行提取脚本
node extract-translations.js

# 4. 解析 Wiki 数据
node parse-wiki-translations.js

# 5. 合并数据
node merge-translations.js

# 6. 验证结果
cat merged-translations.json | jq 'keys'
```

#### Phase 2: 客户端 Fork

```bash
# 1. Fork 官方客户端
git clone https://github.com/smogon/pokemon-showdown-client
cd pokemon-showdown-client

# 2. 创建分支
git checkout -b feature/chinese-translation

# 3. 安装依赖
npm install

# 4. 验证构建
npm run build
```

#### Phase 3: 翻译模块实现

```bash
# 1. 创建目录结构
mkdir -p js/i18n/zh-CN

# 2. 复制翻译数据
cp ../translation-work/extracted-translations/*.js js/i18n/zh-CN/

# 3. 创建主模块
# 编辑 js/i18n/index.js (参考 5.2.1)

# 4. 修改 index.html 加载翻译模块
# 编辑 index.html (参考 5.3.1)
```

#### Phase 4: 客户端改造

需要修改的文件清单：

| 文件 | 修改内容 | 优先级 |
|------|---------|--------|
| `js/battle.js` | 对战日志、精灵名称、技能名称 | P0 |
| `js/battle-tooltips.js` | 悬浮提示 | P0 |
| `js/client-teambuilder.js` | 队伍编辑器 | P0 |
| `js/battle-dex.js` | 数据显示 | P1 |
| `js/battle-dex-search.js` | 搜索结果 | P1 |
| `js/client-mainmenu.js` | 主菜单 | P2 |
| `js/client-chat.js` | 聊天消息 | P2 |

#### Phase 5: 集成测试

测试清单：

- [ ] Teambuilder
  - [ ] 创建新队伍
  - [ ] 添加精灵（显示中文名）
  - [ ] 选择技能（显示中文名）
  - [ ] 选择特性（显示中文名）
  - [ ] 选择道具（显示中文名）
  - [ ] 搜索功能（中英文搜索）

- [ ] 对战
  - [ ] 技能选择界面
  - [ ] 对战日志
  - [ ] 悬浮提示
  - [ ] 效果提示（效果拔群等）

- [ ] 其他
  - [ ] 图鉴页面
  - [ ] 伤害计算器
  - [ ] 回放播放

#### Phase 6: 部署上线

```bash
# 1. 构建生产版本
npm run build

# 2. 配置服务端指向自定义客户端
# 编辑 config/config.js
# pokemonshowdown.com.pokemon-showdown-client 改为你的客户端路径

# 3. 重启服务器
node pokemon-showdown
```

### 7.3 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| 上游客户端更新 | 需要合并冲突 | 定期同步，保持修改最小化 |
| 翻译数据不完整 | 部分内容显示英文 | 建立补充机制，收集反馈 |
| 性能问题 | 页面加载变慢 | 按需加载翻译数据 |
| 搜索功能影响 | 中文搜索不工作 | 实现双向搜索（中英文） |

---

## 8. 附录

### 8.1 相关资源

| 资源 | 说明 | 链接 |
|------|------|------|
| 油猴脚本原版 | PSChina Server Translation SV | [Greasy Fork](https://greasyfork.org/scripts/432623) |
| PS 客户端源码 | pokemon-showdown-client | [GitHub](https://github.com/smogon/pokemon-showdown-client) |
| PS 服务端源码 | pokemon-showdown | [GitHub](https://github.com/smogon/pokemon-showdown) |
| 神奇宝贝百科 | 官方中文名称参考 | [52poke.com](https://wiki.52poke.com) |

### 8.2 翻译术语对照

| 英文 | 官方中文 | 常见译法 |
|------|---------|---------|
| Pokemon | 宝可梦 | 精灵、口袋妖怪 |
| Species | 种族 | 物种 |
| Move | 招式 | 技能 |
| Ability | 特性 | 能力 |
| Item | 道具 | 物品 |
| Nature | 性格 | - |
| EV | 努力值 | 基础点数 |
| IV | 个体值 | - |
| Type | 属性 | 类型 |
| Stat | 能力值 | 数值 |
| Base Stat | 种族值 | 基础能力值 |

### 8.3 常见问题

#### Q: 为什么不直接修改服务端数据？

A: 修改服务端数据会导致：
1. 协议消息中出现中文，影响解析
2. 上游更新时大量合并冲突
3. 回放兼容性问题
4. 难以支持多语言切换

#### Q: 如何支持语言切换？

A: 在 `BattleI18n` 模块中添加语言切换功能：
```javascript
BattleI18n.lang = 'en';  // 切换到英文
BattleI18n.lang = 'zh-CN';  // 切换到简体中文
```

#### Q: 如何处理新增的精灵/技能？

A: 建立更新机制：
1. 监控上游数据更新
2. 从神奇宝贝百科获取官方译名
3. 更新翻译数据文件
4. 重新构建客户端

---

*文档创建时间: 2026-01-25*
*最后更新: 2026-01-25*
