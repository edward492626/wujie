/**
 * 单元测试：startApp 复用分支与 destroy 的竞态防护。
 *
 * 场景：startApp 复用已存在 sandbox 时，await unmount/preload/active 让出主线程，
 * 并发的 destroyApp（如用户关闭 tab）在此期间销毁 sandbox。恢复后 startApp 必须
 * 中止复用，否则 active() 会把已摘除的 iframe 重新 append、__WUJIE_MOUNT() 会把
 * 子应用僵尸复活（iframe 保持 attached，Blink ScriptState 钉死整个 realm）。
 *
 * 同时验证正常 refresh 复用路径（无并发 destroy）不受防护影响。
 */

export {};

import { startApp } from "../../src/index";
import { addSandboxCacheWithWujie, idToSandboxCacheMap } from "../../src/common";
import Wujie from "../../src/sandbox";

function createReusableSandbox(id: string) {
  const iframe = window.document.createElement("iframe");
  window.document.body.appendChild(iframe);
  const iframeWindow: any = iframe.contentWindow;

  const mountFn = jest.fn();
  iframeWindow.__WUJIE_MOUNT = mountFn;

  const inst: any = Object.create(Wujie.prototype);
  inst.id = id;
  inst.destroyed = false;
  inst.mountFlag = true;
  inst.alive = false;
  inst.hrefFlag = false;
  inst.iframe = iframe;
  inst.bus = { $clear: jest.fn(), $destroy: jest.fn() };
  inst.eventCleanupTracker = { cleanupAll: jest.fn() };
  inst.styleSheetElements = [];
  inst.dynamicScriptElements = [];
  inst.fontStyleSheetElements = [];
  inst.deferredStyleObservers = [];
  inst.proxyRevoke = jest.fn();
  inst.rebuildStyleSheets = jest.fn();
  inst.iframeReady = Promise.resolve();

  return { inst, iframe, mountFn };
}

const baseOptions = (name: string) => ({
  name,
  url: "//example.com/app/",
  el: window.document.createElement("div"),
});

describe("startApp 复用分支与 destroy 的竞态防护", () => {
  beforeEach(() => {
    idToSandboxCacheMap.clear();
  });

  test("unmount await 期间被 destroy：不得调用 __WUJIE_MOUNT / active 后复活", async () => {
    const { inst, mountFn } = createReusableSandbox("race-unmount");
    addSandboxCacheWithWujie("race-unmount", inst);

    let releaseUnmount!: () => void;
    const unmountGate = new Promise<void>((r) => (releaseUnmount = r));
    inst.unmount = jest.fn().mockReturnValue(unmountGate);

    const activeFn = jest.fn().mockResolvedValue(undefined);
    inst.active = activeFn;

    const startPromise = startApp(baseOptions("race-unmount"));

    // 让出期间并发 destroy：真实 destroy() 的关键副作用（标志位 + 移除 map）
    await Promise.resolve();
    inst.destroyed = true;
    idToSandboxCacheMap.delete("race-unmount");

    releaseUnmount();
    const result = await startPromise;

    expect(mountFn).not.toHaveBeenCalled();
    expect(inst.mountFlag).toBe(true); // 未被复用分支覆写
    expect(typeof result).toBe("function"); // 返回 destroy 闭包
  });

  test("preload await 期间被 destroy：不得继续复用", async () => {
    const { inst, mountFn } = createReusableSandbox("race-preload");
    addSandboxCacheWithWujie("race-preload", inst);

    let releasePreload!: () => void;
    inst.preload = new Promise<void>((r) => (releasePreload = r));
    inst.unmount = jest.fn().mockResolvedValue(undefined);

    const startPromise = startApp(baseOptions("race-preload"));

    await Promise.resolve();
    inst.destroyed = true;

    releasePreload();
    await startPromise;

    expect(mountFn).not.toHaveBeenCalled();
    expect(inst.unmount).not.toHaveBeenCalled();
  });

  test("active await 期间被 destroy：不得调用 __WUJIE_MOUNT 复活", async () => {
    const { inst, mountFn } = createReusableSandbox("race-active");
    addSandboxCacheWithWujie("race-active", inst);

    inst.unmount = jest.fn().mockResolvedValue(undefined);
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((r) => (releaseActive = r));
    inst.active = jest.fn().mockImplementation(() => {
      // 模拟 active 内部 await iframeReady 期间发生 destroy
      inst.destroyed = true;
      return activeGate;
    });

    const startPromise = startApp(baseOptions("race-active"));
    releaseActive();
    await startPromise;

    expect(mountFn).not.toHaveBeenCalled();
  });

  test("正常 refresh 复用路径（无并发 destroy）：__WUJIE_MOUNT 照常调用", async () => {
    const { inst, mountFn } = createReusableSandbox("refresh-normal");
    addSandboxCacheWithWujie("refresh-normal", inst);

    inst.unmount = jest.fn().mockImplementation(() => {
      // 真实 unmount 会复位 mountFlag
      inst.mountFlag = false;
      return Promise.resolve();
    });
    inst.active = jest.fn().mockResolvedValue(undefined);

    const result = await startApp(baseOptions("refresh-normal"));

    expect(inst.unmount).toHaveBeenCalledTimes(1);
    expect(inst.active).toHaveBeenCalledTimes(1);
    expect(mountFn).toHaveBeenCalledTimes(1);
    expect(inst.mountFlag).toBe(true);
    expect(typeof result).toBe("function");
  });
});

describe("sandbox.active / sandbox.mount 护栏", () => {
  beforeEach(() => {
    idToSandboxCacheMap.clear();
  });

  test("已销毁 sandbox 调 active 应立即返回，不等待 iframeReady", async () => {
    const { inst } = createReusableSandbox("active-guard");
    inst.destroyed = true;
    // iframeReady 永不 resolve：若护栏失效，active 将挂起导致测试超时
    inst.iframeReady = new Promise<void>(() => {});

    await expect(
      inst.active({ url: "//example.com/app/" })
    ).resolves.toBeUndefined();
  });

  test("已销毁 sandbox 调 mount 不得触发 __WUJIE_MOUNT", () => {
    const { inst, mountFn } = createReusableSandbox("mount-guard");
    inst.destroyed = true;
    inst.mountFlag = false;
    inst.execQueue = { shift: jest.fn() };

    inst.mount();

    expect(mountFn).not.toHaveBeenCalled();
    expect(inst.execQueue.shift).not.toHaveBeenCalled();
  });

  test("存活 sandbox 的 mount 正常执行（refresh 后主动 mount 不受影响）", () => {
    const { inst, mountFn } = createReusableSandbox("mount-normal");
    inst.destroyed = false;
    inst.mountFlag = false;
    inst.lifecycles = {};
    inst.el = window.document.createElement("div");
    inst.execQueue = { shift: jest.fn() };

    inst.mount();

    expect(mountFn).toHaveBeenCalledTimes(1);
    expect(inst.mountFlag).toBe(true);
    expect(inst.execQueue.shift).toHaveBeenCalledTimes(1);
  });
});
