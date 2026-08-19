# Chrome Heap Snapshot 离线分析工具（wujie 微前端内存泄漏排查）

`heap.mjs` 用于离线分析 Chrome DevTools 导出的 `.heapsnapshot` 文件，专为 wujie 微前端场景增强了 wujie 沙箱/EventBus 注册表审讯、DevTools 伪影过滤、DOM/闭包保留链追踪、跨 realm 泄漏检测能力。

适用场景：子应用关闭后内存不回落、iframe/ShadowRoot 累积、怀疑 wujie 沙箱或某个 Commit 泄漏时的取证定位。

## 快速开始

```bash
# 所有命令都建议加内存参数（快照普遍 100~250MB）
NODE_OPTS="--max-old-space-size=8192"

node $NODE_OPTS heap.mjs stats "docs/memory heap/页面关闭.heapsnapshot"
```

> 快照文件路径含空格时务必加引号。
> `Heap` 类可被 `import` 复用（作为库），CLI 主逻辑仅在直接运行时执行。

## 排查工作流（三步定位法）

```bash
# 第 1 步：找差异 —— 三快照(基线/打开/关闭)对比
node $NODE_OPTS heap.mjs byname "基线.heapsnapshot" /tmp/base.tsv
node $NODE_OPTS heap.mjs byname "关闭.heapsnapshot" /tmp/closed.tsv
node $NODE_OPTS heap.mjs cmp /tmp/base.tsv /tmp/closed.tsv

# 第 2 步：拿 id —— 可疑类别提取节点 id
node $NODE_OPTS heap.mjs ids "关闭.heapsnapshot" HTMLIFrameElement object

# 第 3 步：追保留链 —— 逆向 BFS 到 GC root
node $NODE_OPTS heap.mjs ret "关闭.heapsnapshot" 4314041
```

## 命令参考

### 1. 总览与对比（排查第一步）

| 命令 | 作用 |
|---|---|
| `stats <file>` | 节点数、GC 可达率、detached 统计、关键类别计数（ShadowRoot/iframe/Window/Document，区分 native 与 object/closure） |
| `byname <file> <out.tsv>` | 按节点名聚合数量与 self_size，输出 TSV |
| `cmp <base.tsv> <cur.tsv>` | 对比两份 byname 结果，按数量差 / 大小差排 TOP30 |
| `meta <file>` | 快照格式元信息（排查解析问题时用） |

**判读**：若关闭后 diff TOP 全是 `ScopeInfo/FeedbackMetadata/TrustedByteArray` 等 V8 引擎内部对象（几百 KB 级），属代码缓存正常驻留，不是泄漏；若出现业务组件名、DOM 标签、闭包数量大增，才继续深挖。

### 2. wujie 专项指纹

```bash
node $NODE_OPTS heap.mjs wujie "页面关闭.heapsnapshot"
```

输出三个 wujie 核心指标：

- **`wujie <html> 壳(_hasPatch, 可达)`**：wujie `patchElementEffect` 打标的 shadow html 壳数量。子应用正常销毁后应回到基线值；每多 1 个 = 有一个沙箱的 DOM 壳被钉住。
- **`__WUJIE/$wujie 属性边`**：挂在 iframe window 上的沙箱引用计数。
- **`ShadowRoot 按类型`**：`native` 才是真 DOM ShadowRoot；`closure` 是同名 JS 函数（某些 polyfill 定义），别混淆。

### 3. wujie 内部注册表审讯（本工具核心增值）

| 命令 | 作用 |
|---|---|
| `sandbox <file>` | 审讯**沙箱注册表** `idToSandboxMap`：每个 entry 的 key、形态（`{wujie,options}` 包装 / 实例本体 / 纯 options 残留）、18 个状态字段（destroyed/mountFlag/alive/iframe…） |
| `events <file>` | 审讯**EventBus 注册表** `appEventObjMap`：每个 entry 的 key、注册事件名及回调数、**时间戳 key 检测**（模块级 bus 指纹）、**空 entry 检测**（跨 realm 泄漏锚点）、**异 realm 检测**（hidden class 钉死已销毁子应用） |

这两个命令直接读 V8 OrderedHashMap 内部 table 数组，是普通 DevTools Retainers 视图看不到的维度：

```bash
node $NODE_OPTS heap.mjs events "页面关闭.heapsnapshot"
```

```text
== wujie EventBus 注册表 appEventObjMap ==
entry 1787120368305
  事件: (空)
  · 时间戳key(模块级bus=new EventBus(Date.now()),非沙箱bus)
  · 空entry(无任何回调,疑似跨realm泄漏锚点)
  ⚠异realm对象(hidden class钉死创建realm,销毁后整个子应用无法GC)
```

**判读要点**：

- **时间戳 key**：`new EventBus(Date.now())` 是 wujie 各模块副本的模块级 bus。每份打包了 wujie 的产物（主应用、EFX 等组件库）各有一个。正常情况只有主应用 1 个；多出来的 = 子应用里加载了第二份 wujie 副本。
- **空 entry + 异 realm**：致命组合（见"泄漏判读知识"第 6 条）。value 对象创建于子应用 iframe realm，销毁后其 hidden class 把整个 realm 钉死。
- **`sandbox` 显示 `options 残留`**：destroy 已执行（设计内），但残留的 options 钉着 lifeCycles 八个闭包 + plugins + props，属于次要泄漏（不钉 iframe）。

### 4. 保留链定位（找到"谁钉住了谁"）

| 命令 | 作用 |
|---|---|
| `ids <file> <name> [type]` | 提取指定名字节点的 id（`type` 可选 `native/object/closure`） |
| `ret <file> <id>` | 从目标逆向 BFS 找**最短**保留链到 GC root |
| `rettree <file> <id> [depth] [width]` | 向上多叉展开保留**树**（最短链不够时用） |
| `inedges <file> <id>` | 只列目标的全部非弱入边（快速看直接引用者） |
| `nodevtools <file> <id>` | **排除 DevTools 节点后**验证是否仍被 JS 强引用（区分真泄漏 vs 快照伪影） |

标准链路：

```bash
# 1. 找到可疑对象 id（如泄漏的 ShadowRoot）
node $NODE_OPTS heap.mjs ids "页面关闭.heapsnapshot" ShadowRoot native
# 2. 看最短保留链
node $NODE_OPTS heap.mjs ret "页面关闭.heapsnapshot" 1244468
# 3. 若链经过 InspectorDOMAgent/v8_inspector，排除伪影再确认
node $NODE_OPTS heap.mjs nodevtools "页面关闭.heapsnapshot" 3301771
```

### 5. 单点解剖

| 命令 | 作用 |
|---|---|
| `dump <file> <id>` | 打印节点全部出边 + **detached 状态**（attached/detached 直接标注） |
| `domparent <file> <id>` | 全图扫描 element 边，找 DOM 父节点（判断元素是否还 attached 在某容器里） |
| `strings <file> <needle>` | 在字符串表检索关键字——**验证快照里跑的代码版本**（如搜 `.ag-popup`、`unmounted` 确认补丁是否生效） |

## 格式要点（改代码前必读）

这些是解析 Chrome heapsnapshot 的关键坑，已全部在 `heap.mjs` 内置处理：

1. **`to_node` 是绝对偏移，不是索引**。edges 里 `to_node` 字段存的是目标节点在 nodes 扁平数组中的起始字节位置，必须 `Math.floor(to_node / NF)` 才得到节点索引。直接当索引用会得到乱图。
2. **weak 边与 `pair in WeakMap` 边不构成保留**。DevTools 的 Retainers 视图会跳过它们，自研 BFS 若不跳过，所有被 WeakRef/WeakMap 弱引用的对象都会显示为"被保留"，得出错误结论。
3. **`detachedness` 字段区分游离 DOM**（值为 1 表示已脱离文档）。仅靠名字前缀 `Detached` 判断会漏（Blink 多数节点无 wrapper 名字）。
4. **同名不同 type 是完全不同的东西**。例如 `ShadowRoot` 既可能是 native DOM 对象，也可能是某 polyfill 的闭包函数，统计时必须按 `name+type` 过滤。
5. **V8 `Map` 的 entry 藏在 `table` 属性指向的数组里**，key/value 以 internal 数字索引边交替存放（`[5]=key1 [6]=val1 [11]=key2 [12]=val2...`），且首个字符串元素之后下一个索引才是 value。`sandbox`/`events` 命令已内置解析。
6. **主 realm 与异 realm 对象在 label 上有细微差别**：主 realm（页面初始 realm）对象的 `__proto__` 边目标 label 带 URL 标注（如 `Object (prototype) / http://...`）；在 iframe realm 里创建的对象无 URL 标注。这是识别"子应用对象逃逸到主 realm 全局表"的关键指纹（`events` 命令的异 realm 检测）。

## 泄漏判读知识（wujie 场景）

按确认难度从易到难排列，前 5 条是常规 JS 引用泄漏，第 6 条是 V8 引擎层泄漏（肉眼不可见）：

1. **attached 的 iframe 不需要任何 JS 引用就能存活**，且 iframe 活 → Blink Frame 活 → `V8PerContextData` 钉住该 realm 全部 DOM wrapper → 整个子应用（html 壳、ShadowRoot、闭包、组件树）无法 GC。所以看到「iframe `detached=0` + 无 JS 入边」= **destroy 没执行 removeChild**，这是最典型的 wujie 泄漏形态。
2. **`ret` 链出现 `InspectorDOMAgent` / `v8_inspector`**：DevTools 抓快照时 Elements 面板会钉住最近查看的节点，属伪影，用 `nodevtools` 复核。
3. **`V8PerContextData` / `ScriptStateImpl` 出现在链上**：说明泄漏源是某个还活着的 realm（iframe window），应继续追是谁保活了该 iframe，而不是在 DOM 树里打转。
4. **detached 的大树 + 链上有 `appEventObjMap`（wujie EventBus）**：子应用关闭时事件回调没清，EventBus 闭包钉住渲染上下文。对应修复是 wujie destroy 里的 `bus.$destroy()`。
5. **Vue3 组件库钩子失效陷阱**：组件库若在 Options API 里用 `beforeDestroy` 注册清理（Vue2 钩子名），在 Vue3 下**静默不执行**——不报错、无警告，清理逻辑全部失效。凡组件库清理代码挂在生命周期钩子上的，升级 Vue3 时必须检查钩子名（`beforeDestroy`→`beforeUnmount`/`unmounted`）。用 `strings` 搜快照里的钩子名可确认线上代码版本。
6. **V8 hidden class 跨 realm 钉死（本工具 `events` 命令的专属战场）**：任何 JS 对象的 hidden class（object shape）**固有引用其创建时的 NativeContext（realm）**。因此只要主 realm 的全局容器（如 `appEventObjMap`）残留一个"在子应用 iframe realm 里创建的对象"——哪怕它是个**空对象、没有任何回调**——整个子应用 realm（iframe + 全部 DOM + JS 堆）就永久无法 GC。ret/dump 等 JS 引用分析对它完全失效（对象本身是空的），必须看 `map → native_context` 内部边或用 `events` 命令的异 realm 检测。
7. **多份 wujie 副本叠加**：主应用、EFX/ERX 等组件库各自打包 wujie 时，每个副本有独立的模块级 bus（时间戳 id）且**共享同一个跨 realm `appEventObjMap`**（通过 `window.__WUJIE_INJECT` 传递）。子应用内加载的副本销毁后无人调它的 `$destroy`，空 entry 残留即触发第 6 条。修复思路：destroy 时统一清理 map 中所有空 entry。
8. **async destroy 竞态**：`destroyApp` 是 async、`wujie-vue3` 的 `destroy()` 不 await；`startApp` 复用分支在每个 `await` 恢复点都可能与并发的 destroy 交错，把已销毁的 iframe 重新 append 回容器（僵尸复活）。日志特征：`beforeUnmount` 与 `afterUnmount` 之间夹着子应用的 `mount` 日志。
9. **单次开关不足以证明泄漏**：竞态类问题可能间歇命中，建议连续开关 10 次后拍快照，对比指标是否线性增长。

## 实战案例（本项目已修复的泄漏，按发现顺序）

所有案例的快照存于 `docs/memory heap/`（old/old1/old2 为历史代）。

### 案例 1：嵌套子应用旧版 wujie 的 iframe 未摘除

三快照 `stats` 显示关闭后 ShadowRoot(native) +59、iframe +1 → `ids ShadowRoot native` + `ret` 追链 → 链终点是 `detached=0` 的 iframe#4314041 → `nodevtools` 确认非伪影、realm 被 `V8PerContextData` 保活 → 定位根因：**嵌套 wujie（孙应用 erx）用的 wujie@1.0.24 旧版 destroy 无同步 removeChild**，升级 2.1.0 + 补丁后解决。

### 案例 2：Vue3 钩子名失效导致 `$offAll` 永不执行

`events` 前身分析发现 appEventObjMap 时间戳 entry 里 `_wujie_all_event` 数组非空，元素是 `handleEmit.bind(JSProxy)`（Vue3 Options API methods 自动绑定组件实例代理的指纹）→ wujie-vue3 组件在 `created` 里 `bus.$onAll(this.handleEmit)`，清理挂在 **`beforeDestroy`**（Vue2 钩子，Vue3 中静默失效）→ 每关一个 tab 泄漏一个 handleEmit 闭包，钉住整个组件树 + sandbox。修复：钩子名改 `unmounted`。

### 案例 3：destroy 中途异常夭折

快照显示 `idToSandboxMap` 只剩 `{options}`（destroy 前半执行了）但 iframe `detached=0`（后半没执行）→ destroy 体内唯一可抛点 `clearChild(this.el)` 与 Vue 并发卸载同一子树时抛 NotFoundError，同步异常中断 destroy，iframe 摘除被跳过。修复：el 清理 / 事件解绑 / iframe 摘除三段全部 try/catch 隔离，保证 `removeChild(iframe)` 必达。

### 案例 4：startApp 复用分支竞态僵尸复活

console 日志 `beforeUnmount` → `SOSO app mount` → `afterUnmount`（销毁三连中间夹着重挂）→ startApp 复用分支 `await sandbox.unmount()` 让出微任务期间，用户关 tab 触发 destroy 同步跑完；恢复后 startApp 继续 `active()` 把已摘除 iframe 重新 append + `__WUJIE_MOUNT()` 僵尸复活。修复：复用/新建/preload 分支每个 await 恢复点校验 `sandbox.destroyed`，`active()`/`mount()` 加同款护栏（配套 7 条竞态单测）。

### 案例 5：V8 hidden class 跨 realm 钉死（最隐蔽）

所有 JS 引用修复生效后快照仍有 2 个 `detached=0` iframe。`events` 审讯发现时间戳 entry `1787120368305` 为**空对象且异 realm**：EFX 组件库在子应用里加载了第二份 wujie 副本，其模块级 bus 构造时向共享 `appEventObjMap` set 了创建于 iframe realm 的 `{}`；副本随 iframe 销毁后无人 `$destroy`，空 entry 残留 → hidden class 钉死整个子应用 realm。修复：sandbox.destroy() 统一清理 map 中所有空 entry。

## 附：修复验收基线

全部修复部署后，"载入子应用 → 关闭" 的快照应满足：

```text
stats:   HTMLIFrameElement(obj/native) 归零（或回到基线）
         ShadowRoot(native) 回到基线值
wujie:   _hasPatch 壳数回到基线
events:  时间戳 entry 仅剩主应用 1 个；无"空 entry"/"异 realm"告警
sandbox: 仅剩 {options} 残留（次要泄漏，可接受）或全空
```
