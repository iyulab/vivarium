/**
 * Reference react-tsx profile instance (ADR-0003/0004) for harness use.
 * The runtime core does not depend on this — a profile is plain data:
 * embedded module sources + a host-side transform.
 *
 * `react` and `react-dom/client` are thin wrappers over one bundled
 * runtime module, so every consumer shares a single react instance
 * (duplicate instances would break hooks).
 */
import { transform } from "./assets/sucrase.js";

const REACT_WRAPPER = `
import { React } from "@vivarium/react-runtime";
export default React;
export const {
  Children, Component, Fragment, Profiler, PureComponent, StrictMode, Suspense,
  cloneElement, createContext, createElement, createRef, forwardRef,
  isValidElement, lazy, memo, startTransition,
  use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue,
  useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect,
  useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore,
  useTransition, version,
} = React;
`;

const REACT_DOM_CLIENT_WRAPPER = `
import { ReactDOMClient } from "@vivarium/react-runtime";
export default ReactDOMClient;
export const { createRoot, hydrateRoot } = ReactDOMClient;
`;

export async function loadReactTsxProfile(assetBase = "./assets/") {
  const runtimeSource = await fetch(assetBase + "react-runtime.js").then((r) => {
    if (!r.ok) throw new Error("missing profile assets — run: node tools/build-profile-assets.ts");
    return r.text();
  });
  return {
    name: "react-tsx@0",
    modules: {
      "@vivarium/react-runtime": runtimeSource,
      "react": REACT_WRAPPER,
      "react-dom/client": REACT_DOM_CLIENT_WRAPPER,
    },
    transform: (code) =>
      transform(code, {
        transforms: ["typescript", "jsx"],
        jsxRuntime: "classic",
        production: true,
      }).code,
  };
}
