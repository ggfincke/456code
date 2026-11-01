import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { linkedThreadStep, parentThreadIsBelow } from "./linked-thread-navigation";

const require = NodeModule.createRequire(import.meta.url);
const nativePackage = require.resolve("@react-navigation/native/package.json");
const requireFromNative = NodeModule.createRequire(nativePackage);
const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
const requireFromCore = NodeModule.createRequire(corePackage);
const { StackActions, StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};
const router = StackRouter({});
const options = {
  routeNames: [
    "Home",
    "Thread",
    "ThreadFiles",
    "ThreadTerminal",
    "GitOverview",
    "PullRequest",
    "PullRequestFile",
    "PullRequestReviewers",
    "Settings",
    "SettingsEnvironments",
    "SettingsAppearance",
    "SettingsOpenSourceLicenses",
    "SettingsUsage",
    "SettingsUsageAccount",
  ],
  routeParamList: {},
  routeGetIdList: {},
};
const thread = {
  name: "Thread",
  params: { environmentId: "environment-a", threadId: "thread-a" },
} as const;

function apply(
  state: ReturnType<typeof router.getInitialState>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const result = router.getStateForAction(state, action, options);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, options);
}

function withThread() {
  return apply(router.getInitialState(options), StackActions.push(thread.name, thread.params));
}

describe("linked thread navigation", () => {
  it("opens a linked thread above the current one so Back returns to it", () => {
    const parent = withThread();
    const child = { ...thread.params, threadId: "child-a" };
    const open = (
      state: ReturnType<typeof router.getInitialState>,
      target: ReactNavigation.RootParamList["Thread"],
    ) => {
      const step = linkedThreadStep(state, target);
      if (step === "stay") return state;
      return apply(
        state,
        step === "pop" ? StackActions.pop() : StackActions.push("Thread", target),
      );
    };

    const inChild = open(parent, child);
    expect(inChild.routes.map((route) => route.params)).toEqual([undefined, thread.params, child]);
    expect(open(inChild, child)).toBe(inChild);

    const backInParent = open(inChild, thread.params);
    expect(backInParent.routes).toEqual(parent.routes);
    expect(backInParent.index).toBe(parent.index);
  });

  it("recognizes a parent only when its environment and thread are immediately below", () => {
    const parent = withThread();
    const child = apply(
      parent,
      StackActions.push("Thread", { ...thread.params, threadId: "child-a" }),
    );

    expect(parentThreadIsBelow(child, thread.params)).toBe(true);
    expect(parentThreadIsBelow(child, { ...thread.params, environmentId: "environment-b" })).toBe(
      false,
    );
    expect(parentThreadIsBelow(child, { ...thread.params, threadId: "other" })).toBe(false);
    expect(parentThreadIsBelow(parent, thread.params)).toBe(false);
    expect(
      parentThreadIsBelow(
        apply(child, StackActions.push("Thread", { ...thread.params, threadId: "grandchild-a" })),
        thread.params,
      ),
    ).toBe(false);
  });
});
