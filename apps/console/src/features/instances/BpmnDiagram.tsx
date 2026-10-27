import { useEffect, useRef, useState } from "react";
import { layout } from "../../shared/theme/theme";

/**
 * The process diagram with the path this instance took: completed elements, where it waits, where it stopped.
 * bpmn-js is loaded only when a diagram is shown.
 */
export function BpmnDiagram({ xml, completed, active, incidents }: { xml: string; completed: string[]; active: string[]; incidents: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let viewer: { destroy: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { default: Viewer } = await import("bpmn-js/lib/NavigatedViewer");
        if (cancelled || !ref.current) return;
        const v = new Viewer({ container: ref.current });
        viewer = v;
        await v.importXML(xml);
        const canvas = v.get("canvas") as { zoom: (m: string) => void; addMarker: (id: string, c: string) => void };
        canvas.zoom("fit-viewport");
        for (const id of completed) canvas.addMarker(id, "m-done");
        for (const id of active) canvas.addMarker(id, "m-active");
        for (const id of incidents) canvas.addMarker(id, "m-incident");
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
    };
  }, [xml, completed, active, incidents]);
  if (error) return <p className="state-text">The diagram could not be drawn: {error}</p>;
  return <div ref={ref} className="diagram" style={{ height: layout.diagramHeight }} aria-label="Process diagram with this instance's path" role="img" />;
}
