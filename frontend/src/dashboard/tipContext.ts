import { createContext, useCallback, useContext, useMemo, type FocusEvent, type PointerEvent } from "react";

/** One tooltip row. The value leads; the colour keys it to its series. */
export interface TipRow { label: string; value: string; color?: string }

export interface TipContent { title: string; rows: TipRow[] }

/** Tooltip state setter, supplied by TipLayer. */
export interface TipApi {
  show: (content: TipContent, x: number, y: number) => void;
  hide: () => void;
}

export const TipContext = createContext<TipApi>({ show: () => {}, hide: () => {} });

export function useTipApi(): TipApi {
  return useContext(TipContext);
}

/** Show the tooltip above an element, for keyboard focus where there is no pointer. */
export function tipAtElement(api: TipApi, content: TipContent, element: Element): void {
  const box = element.getBoundingClientRect();
  api.show(content, box.left + box.width / 2, box.top);
}

/** Handlers giving any mark the same tooltip on hover and on keyboard focus. */
export function useMarkTip(content: TipContent) {
  const api = useTipApi();
  const key = JSON.stringify(content);
  const onPointerMove = useCallback((e: PointerEvent) => api.show(content, e.clientX, e.clientY),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content's value
    [api, key]);
  const onFocus = useCallback((e: FocusEvent) => tipAtElement(api, content, e.currentTarget),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the content's value
    [api, key]);
  return useMemo(() => ({ onPointerMove, onFocus, onPointerLeave: api.hide, onBlur: api.hide }), [onPointerMove, onFocus, api]);
}
