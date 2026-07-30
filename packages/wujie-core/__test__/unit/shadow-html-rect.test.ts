import { renderTemplateToShadowRoot } from "../../src/shadow";
import { WUJIE_SHADE_STYLE } from "../../src/constant";
import {
  addSandboxCacheWithWujie,
  deleteWujieById,
  idToSandboxCacheMap,
  rawElementAppendChild,
} from "../../src/common";

const GEOMETRY_PROPERTIES: Array<
  | "clientHeight"
  | "clientWidth"
  | "clientTop"
  | "clientLeft"
  | "scrollHeight"
  | "scrollWidth"
  | "scrollTop"
  | "scrollLeft"
  | "offsetHeight"
  | "offsetWidth"
  | "offsetTop"
  | "offsetLeft"
> = [
  "clientHeight",
  "clientWidth",
  "clientTop",
  "clientLeft",
  "scrollHeight",
  "scrollWidth",
  "scrollTop",
  "scrollLeft",
  "offsetTop",
  "offsetLeft",
  "offsetHeight",
  "offsetWidth",
];

describe("renderTemplateToShadowRoot shadowHtml 几何语义补丁", () => {
  const APP_ID = "rect-test";

  beforeEach(() => {
    idToSandboxCacheMap.clear();
  });
  afterEach(() => {
    deleteWujieById(APP_ID);
    idToSandboxCacheMap.clear();
  });

  async function mountShadowRenderTo(
    host: HTMLElement,
    iframeWindowStub: any = {}
  ): Promise<{ shadowRoot: ShadowRoot; shadowHtml: HTMLElement; shadowBody: HTMLElement | null }> {
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const realIframeWindow = iframe.contentWindow as Window & {
      __WUJIE: Record<string, any>;
    };

    const styleSheetElements: any[] = [];
    const fakeSandbox: any = {
      id: APP_ID,
      styleSheetElements,
      replace: {},
      fetch: (window.fetch && window.fetch.bind(window)) || (() => Promise.resolve(new Response("")) as any),
      plugins: [],
      iframe,
      lifecycles: { loadError: () => {} },
      proxyLocation: realIframeWindow.location,
    };
    addSandboxCacheWithWujie(APP_ID, fakeSandbox);

    realIframeWindow.__WUJIE = {
      plugins: [],
      replace: {},
      head: realIframeWindow.document.head,
      body: realIframeWindow.document.body,
      alive: false,
      execFlag: false,
      id: APP_ID,
      url: "about:blank",
      iframe,
      fetch: fakeSandbox.fetch,
      lifecycles: fakeSandbox.lifecycles,
      styleSheetElements,
      ...iframeWindowStub,
    };
    realIframeWindow.__WUJIE.proxyLocation = realIframeWindow.location;

    await renderTemplateToShadowRoot(
      shadowRoot,
      realIframeWindow,
      "<html><head></head><body><div>hi</div></body></html>"
    );

    return {
      shadowRoot,
      shadowHtml: shadowRoot.firstElementChild as HTMLElement,
      shadowBody: shadowRoot.body as HTMLElement | null,
    };
  }

  function rawAppendChild<T extends Node>(parent: Node, newChild: T): T {
    return rawElementAppendChild.call(parent, newChild) as T;
  }

  test("shadowHtml 第一个子节点应为 shade 元素且样式为 WUJIE_SHADE_STYLE", async () => {
    const host = document.createElement("div");
    const { shadowHtml } = await mountShadowRenderTo(host);
    const shade = shadowHtml.firstElementChild as HTMLElement | null;
    expect(shade).toBeTruthy();
    expect(shade!.getAttribute("style")).toBe(WUJIE_SHADE_STYLE);
  });

  test("shadowHtml.getBoundingClientRect 应等于 shade.getBoundingClientRect", async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:120px;top:80px;width:600px;height:400px;";
    const { shadowHtml } = await mountShadowRenderTo(host);
    const shade = shadowHtml.firstElementChild as HTMLElement;
    const htmlRect = shadowHtml.getBoundingClientRect();
    const shadeRect = shade.getBoundingClientRect();
    expect(htmlRect.left).toBe(shadeRect.left);
    expect(htmlRect.top).toBe(shadeRect.top);
    expect(htmlRect.right).toBe(shadeRect.right);
    expect(htmlRect.bottom).toBe(shadeRect.bottom);
    expect(htmlRect.width).toBe(shadeRect.width);
    expect(htmlRect.height).toBe(shadeRect.height);
  });

  test("shadowHtml.getBoundingClientRect 在 .ag-popup 存在时应降级为 shadowBody rect（AG Grid 兼容例外）", async () => {
    const host = document.createElement("div");
    const { shadowHtml, shadowBody } = await mountShadowRenderTo(host);
    expect(shadowBody).toBeTruthy();
    const agPopup = document.createElement("div");
    agPopup.className = "ag-popup";
    rawAppendChild(shadowBody!, agPopup);
    const htmlRect = shadowHtml.getBoundingClientRect();
    const bodyRect = shadowBody!.getBoundingClientRect();
    expect(htmlRect.left).toBe(bodyRect.left);
    expect(htmlRect.top).toBe(bodyRect.top);
    expect(htmlRect.right).toBe(bodyRect.right);
    expect(htmlRect.bottom).toBe(bodyRect.bottom);
  });

  test("shadowHtml clientWidth/clientLeft/scrollWidth/scrollLeft/offsetWidth/offsetTop 等几何属性应直接返回宿主 html 对应值", async () => {
    const host = document.createElement("div");
    const { shadowHtml } = await mountShadowRenderTo(host);
    const hostHtml = document.documentElement as HTMLElement;
    GEOMETRY_PROPERTIES.forEach((key) => {
      expect(shadowHtml[key]).toBe(hostHtml[key]);
    });
  });

  test("shadowHtml offsetWidth/offsetHeight 在 .ag-popup 存在时应返回 shadowBody 对应值", async () => {
    const host = document.createElement("div");
    const { shadowHtml, shadowBody } = await mountShadowRenderTo(host);
    expect(shadowBody).toBeTruthy();
    Object.defineProperty(shadowBody!, "offsetWidth", { configurable: true, value: 777 });
    Object.defineProperty(shadowBody!, "offsetHeight", { configurable: true, value: 888 });
    const agPopup = document.createElement("div");
    agPopup.className = "ag-popup";
    rawAppendChild(shadowBody!, agPopup);
    expect(shadowHtml.offsetWidth).toBe(777);
    expect(shadowHtml.offsetHeight).toBe(888);
  });

  test("shadowHtml.scrollTop/scrollLeft 写操作应同步到宿主 html", async () => {
    const host = document.createElement("div");
    const { shadowHtml } = await mountShadowRenderTo(host);
    const hostHtml = document.documentElement as HTMLElement;
    const originalScrollTop = hostHtml.scrollTop;
    const originalScrollLeft = hostHtml.scrollLeft;
    try {
      shadowHtml.scrollTop = 12;
      shadowHtml.scrollLeft = 34;
      expect(hostHtml.scrollTop).toBe(shadowHtml.scrollTop);
      expect(hostHtml.scrollLeft).toBe(shadowHtml.scrollLeft);
    } finally {
      hostHtml.scrollTop = originalScrollTop;
      hostHtml.scrollLeft = originalScrollLeft;
    }
  });
});
