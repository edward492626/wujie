import { renderTemplateToShadowRoot } from "../../src/shadow";
import { WUJIE_SHADE_STYLE } from "../../src/constant";

describe("renderTemplateToShadowRoot.html.getBoundingClientRect", () => {
  async function mountShadowRenderTo(
    host: HTMLElement,
    iframeWindowStub: any = {}
  ): Promise<{ shadowRoot: ShadowRoot; shadowHtml: HTMLElement }> {
    document.body.appendChild(host);
    const shadowRoot = host.attachShadow({ mode: "open" });

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const realIframeWindow = iframe.contentWindow as Window & {
      __WUJIE: Record<string, any>;
    };
    realIframeWindow.__WUJIE = {
      plugins: [],
      replace: {},
      head: realIframeWindow.document.head,
      body: realIframeWindow.document.body,
      alive: false,
      execFlag: false,
      id: "rect-test",
      url: "about:blank",
      iframe,
      fetch: (window.fetch && window.fetch.bind(window)) || (() => Promise.resolve(new Response("")) as any),
      lifecycles: { loadError: () => {} },
      ...iframeWindowStub,
    };
    realIframeWindow.__WUJIE.proxyLocation = realIframeWindow.location;

    await renderTemplateToShadowRoot(
      shadowRoot,
      realIframeWindow,
      "<html><head></head><body><div>hi</div></body></html>"
    );

    return { shadowRoot, shadowHtml: shadowRoot.firstElementChild as HTMLElement };
  }

  test("shadowHtml 第一个子节点应为 shade 元素且样式为 WUJIE_SHADE_STYLE", async () => {
    const host = document.createElement("div");
    const { shadowHtml } = await mountShadowRenderTo(host);
    const shade = shadowHtml.firstElementChild as HTMLElement | null;
    expect(shade).toBeTruthy();
    expect(shade!.getAttribute("style")).toBe(WUJIE_SHADE_STYLE);
  });

  test("shadowHtml.getBoundingClientRect 应等于 shade.getBoundingClientRect（方案A语义）", async () => {
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:120px;top:80px;width:600px;height:400px;";
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
});
