import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { drewPluginsLastTime, pluginUiEnvironmentsAtom } from "./pluginFollow";

// Module level: React Compiler cannot compile a component that calls import() itself.
const loadPluginWatch = () => import("./pluginWatch");
const loadPluginLoader = () => import("./pluginLoader");
const loadPluginStyles = () => import("./pluginStyles");
const loadPluginFleetSync = () => import("./pluginFleetSync");

const whenIdle = (run: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(run);
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(run, 1);
  return () => window.clearTimeout(handle);
};

export function PluginLoaderStarter() {
  const environmentIds = useAtomValue(pluginUiEnvironmentsAtom);
  return (
    <>
      <PluginFleetStarter />
      {environmentIds.map((environmentId) => (
        <PluginEnvironmentLoader key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

// Plugin sharing copies plugins between the user's machines whenever this window is open, so a
// machine that connects later catches up without a visit to Settings. It waits for an idle moment.
function PluginFleetStarter() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a sync loop that lives outside React
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    const cancelIdle = whenIdle(() => {
      void loadPluginFleetSync().then((module) => {
        if (!cancelled) stop = module.startPluginFleetSync();
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
      stop?.();
    };
  }, []);
  return null;
}

// Downloads the web plugin runtime only once a plugin of the environment has an active web part,
// and the small stylesheet runtime only once one has a `styles` folder.
function PluginEnvironmentLoader({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and stops a runtime that lives outside React
  useEffect(() => {
    let cancelled = false;
    const stops: Array<() => void> = [];
    const start = () => {
      void loadPluginWatch().then(
        ({ watchForPlugins, isLoadableWebPlugin, hasLoadableStyles, rememberDrawingPlugins }) => {
          if (cancelled) return;
          stops.push(
            rememberDrawingPlugins(environmentId),
            watchForPlugins(environmentId, isLoadableWebPlugin, () => {
              void loadPluginLoader().then((module) => {
                if (cancelled) return;
                stops.push(
                  module.startPluginLoader(environmentId, (path) => router.history.push(path)),
                );
              });
            }),
            watchForPlugins(environmentId, hasLoadableStyles, () => {
              void loadPluginStyles().then((module) => {
                if (cancelled) return;
                stops.push(module.startPluginStyles(environmentId));
              });
            }),
          );
        },
      );
    };
    let cancelIdle: (() => void) | undefined;
    if (drewPluginsLastTime(environmentId)) start();
    else cancelIdle = whenIdle(start);
    return () => {
      cancelled = true;
      cancelIdle?.();
      for (const stop of stops) stop();
    };
  }, [environmentId, router]);
  return null;
}
