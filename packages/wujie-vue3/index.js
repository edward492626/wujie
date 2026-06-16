import { bus, preloadApp, startApp as rawStartApp, destroyApp, setupApp, refreshApp } from "wujie";
import { h, defineComponent, ref, onMounted, onBeforeUnmount, watch } from "vue";

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
  setup(props, { emit }) {
    let isUnmounted = false;
    const startAppQueue = ref(Promise.resolve());
    const wujieRef = ref(null);

    function handleEmit(event, ...args) {
      emit(event, ...args);
    }

    async function startApp() {
      // 组件已卸载，阻止残留的 Promise .then(startApp) 创建孤儿 sandbox
      if (isUnmounted) return;
      try {
        const destroyAppFn = await rawStartApp({
          name: props.name,
          url: props.url,
          el: wujieRef.value,
          loading: props.loading,
          alive: props.alive,
          fetch: props.fetch,
          props: props.props,
          attrs: props.attrs,
          replace: props.replace,
          sync: props.sync,
          prefix: props.prefix,
          fiber: props.fiber,
          degrade: props.degrade,
          plugins: props.plugins,
          beforeLoad: props.beforeLoad,
          beforeMount: props.beforeMount,
          afterMount: props.afterMount,
          beforeUnmount: props.beforeUnmount,
          afterUnmount: props.afterUnmount,
          activated: props.activated,
          deactivated: props.deactivated,
          loadError: props.loadError,
          iframeAddEventListeners: props.iframeAddEventListeners,
          iframeOnEvents: props.iframeOnEvents,
        });
        // rawStartApp 在异步加载期间组件可能已卸载，立即销毁刚创建的孤儿 sandbox
        if (isUnmounted && destroyAppFn) {
        // if (destroyAppFn) {
          destroyAppFn();
        }
      } catch (error) {
        console.log(error);
      }
    }

    function execStartApp() {
       // 卸载后 watch 残留触发不应再入队
      if (isUnmounted) return;
      startAppQueue.value = startAppQueue.value.then(startApp);
      if (props.name && window.__WUJIE_QUEUE) {
        window.__WUJIE_QUEUE[props.name] = startAppQueue.value;
      }
    }

    // 初始化队列
    if (props.name) {
      if (window.__WUJIE_QUEUE) {
        if (window.__WUJIE_QUEUE[props.name]) {
          startAppQueue.value = window.__WUJIE_QUEUE[props.name];
        } else {
          window.__WUJIE_QUEUE[props.name] = startAppQueue.value;
        }
      } else {
        window.__WUJIE_QUEUE = {
          [props.name]: startAppQueue.value,
        };
      }
    }

    onMounted(() => {
      bus.$onAll(handleEmit);
      execStartApp();
    });

    onBeforeUnmount(() => {
      isUnmounted = true;
      bus.$offAll(handleEmit);
      clearStartAppQueue(props.name, startAppQueue.value);
    });

    watch(
      () => [props.name, props.url],
      () => execStartApp()
    );

    return () =>
      h("div", {
        style: {
          width: props.width,
          height: props.height,
          ...props.style,
        },
        ref: wujieRef,
      });
  },
});

WujieVue.setupApp = setupApp;
WujieVue.preloadApp = preloadApp;
WujieVue.bus = bus;
WujieVue.destroyApp = destroyApp;
WujieVue.refreshApp = refreshApp;
WujieVue.install = function (app) {
  app.component("WujieVue", WujieVue);
};

export default WujieVue;
