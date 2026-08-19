import { bus, preloadApp, startApp as rawStartApp, destroyApp as wujieDestroyApp, setupApp, refreshApp as wujieRefreshApp } from "wujie";
import { h, defineComponent } from "vue";

/**
 * 清理全局 startApp 串行队列，防止组件销毁后 window.__WUJIE_QUEUE 长期持有
 * 已卸载实例的 Promise 链，造成内存泄漏。
 * 仅当全局队列仍指向当前实例的链尾时才删除，避免误删被同名新实例接管的队列。
 */
function clearStartAppQueue(name, queue) {
  if (!name || !window.__WUJIE_QUEUE) return;
  if (window.__WUJIE_QUEUE[name] === queue) {
    delete window.__WUJIE_QUEUE[name];
  }
}

const WujieVue = defineComponent({
  name: "WujieVue",
  expose: ["refresh", "destroy"],
  props: {
    width: { type: String, default: "" },
    height: { type: String, default: "" },
    name: { type: String, default: "" },
    loading: { type: HTMLElement, default: undefined },
    url: { type: String, default: "" },
    sync: { type: Boolean, default: undefined },
    prefix: { type: Object, default: undefined },
    alive: { type: Boolean, default: undefined },
    props: { type: Object, default: undefined },
    attrs: { type: Object, default: undefined },
    replace: { type: Function, default: undefined },
    fetch: { type: Function, default: undefined },
    fiber: { type: Boolean, default: undefined },
    degrade: { type: Boolean, default: undefined },
    plugins: { type: Array, default: null },
    beforeLoad: { type: Function, default: null },
    beforeMount: { type: Function, default: null },
    afterMount: { type: Function, default: null },
    beforeUnmount: { type: Function, default: null },
    afterUnmount: { type: Function, default: null },
    activated: { type: Function, default: null },
    deactivated: { type: Function, default: null },
    loadError: { type: Function, default: null },
    // eslint-disable-next-line vue/no-reserved-props
    style: { type: Object, default: undefined },
    iframeAddEventListeners: { type: Array, default: null },
    iframeOnEvents: { type: Array, default: null },
  },
  data() {
    return {
      startAppQueue: Promise.resolve(),
      isUnmounted: false,
    };
  },
  mounted() {
    // 初始化串行队列
    if (this.name) {
      if (window.__WUJIE_QUEUE) {
        if (window.__WUJIE_QUEUE[this.name]) {
          this.startAppQueue = window.__WUJIE_QUEUE[this.name];
        } else {
          window.__WUJIE_QUEUE[this.name] = this.startAppQueue;
        }
      } else {
        window.__WUJIE_QUEUE = {
          [this.name]: this.startAppQueue,
        };
      }
    }
    bus.$onAll(this.handleEmit);
    this.execStartApp();

    // 监听 name/url 变化，自动重建
    this.$watch(
      () => this.name + this.url,
      () => this.execStartApp()
    );
  },
  // Vue3 钩子名为 unmounted（Vue2 的 beforeDestroy 在 Vue3 中不会触发）。
  // 若沿用 beforeDestroy，bus.$offAll(this.handleEmit) 永远不执行，
  // 每次组件销毁都会向全局 bus 泄漏一个 handleEmit 闭包，
  // 该闭包经组件实例代理钉住整个 sandbox（含 iframe 与子应用 DOM 树）。
  unmounted() {
    this.isUnmounted = true;
    bus.$offAll(this.handleEmit);
    clearStartAppQueue(this.name, this.startAppQueue);
  },
  methods: {
    handleEmit(event, ...args) {
      this.$emit(event, ...args);
    },
    async startApp() {
      // 拦截组件卸载后仍残留在 __WUJIE_QUEUE Promise 链中的 .then(startApp) 幽灵执行
      if (this.isUnmounted) return;
      try {
        const destroy = await rawStartApp({
          name: this.name,
          url: this.url,
          el: this.$refs.wujie,
          loading: this.loading,
          alive: this.alive,
          fetch: this.fetch,
          props: this.props,
          attrs: this.attrs,
          replace: this.replace,
          sync: this.sync,
          prefix: this.prefix,
          fiber: this.fiber,
          degrade: this.degrade,
          plugins: this.plugins,
          beforeLoad: this.beforeLoad,
          beforeMount: this.beforeMount,
          afterMount: this.afterMount,
          beforeUnmount: this.beforeUnmount,
          afterUnmount: this.afterUnmount,
          activated: this.activated,
          deactivated: this.deactivated,
          loadError: this.loadError,
          iframeAddEventListeners: this.iframeAddEventListeners,
          iframeOnEvents: this.iframeOnEvents,
        });
        // 异步创建跨越了卸载点，兜底销毁孤儿 sandbox
        if (this.isUnmounted && typeof destroy === "function") {
          destroy();
        }
      } catch (error) {
        console.log(error);
      }
    },
    execStartApp() {
      // 卸载后 watch 残留触发不应再入队
      if (this.isUnmounted) return;
      this.startAppQueue = this.startAppQueue.then(this.startApp);
      if (this.name && window.__WUJIE_QUEUE) {
        window.__WUJIE_QUEUE[this.name] = this.startAppQueue;
      }
    },
    /** 销毁当前子应用沙箱（不销毁组件自身） */
    destroy() {
      wujieDestroyApp(this.name);
    },
    /** 销毁当前子应用实例并复用组件容器全量重建（关闭重开语义） */
    async refresh() {
      if (this.isUnmounted) return;
      await wujieDestroyApp(this.name);
      this.execStartApp();
      return this.startAppQueue;
    },
  },
  render() {
    return h("div", {
      style: {
        width: this.width,
        height: this.height,
        ...this.style,
      },
      ref: "wujie",
    });
  },
});

WujieVue.setupApp = setupApp;
WujieVue.preloadApp = preloadApp;
WujieVue.bus = bus;
WujieVue.destroyApp = wujieDestroyApp;
WujieVue.refreshApp = wujieRefreshApp;
WujieVue.install = function (app) {
  app.component("WujieVue", WujieVue);
};

export default WujieVue;
