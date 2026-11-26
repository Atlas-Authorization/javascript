'use client';

import { createContext, createElement, useContext, type ReactNode } from 'react';

/**
 * `<SignIn allowedMethods>` / `<SignUp allowedMethods>`. A list of methods only changes what the panel draws.
 * The signed token (`token` from `pageTemplates.hostedMethodFilter`, `<methods>.<signature>`) also goes to the
 * server on every call, which binds it to the attempt and refuses a session for a method outside it.
 */
export interface AllowedMethodsValue {
  list: readonly string[];
  /** The signed token, when the prop carried one. */
  token: string | null;
}

export const AllowedMethodsContext = createContext<AllowedMethodsValue | null>(null);

/** The methods the panel may offer, or null for no limit. */
export function useAllowedMethods(): readonly string[] | null {
  return useContext(AllowedMethodsContext)?.list ?? null;
}

/** The signed token to send with every call, or null (a plain list is UI only). */
export function useMethodFilterToken(): string | null {
  return useContext(AllowedMethodsContext)?.token ?? null;
}

/** `allowedMethods` as a prop: a list, or the signed token string. Empty = no limit. */
export function parseAllowedMethods(value: string[] | string | undefined): AllowedMethodsValue | null {
  if (typeof value === 'string') {
    const i = value.lastIndexOf('.');
    const list = i > 0 ? value.slice(0, i).split(',').filter(Boolean) : [];
    return list.length ? { list, token: value } : null;
  }
  return value?.length ? { list: value, token: null } : null;
}

export function AllowedMethodsProvider(props: { value: string[] | string | undefined; children: ReactNode }) {
  const parsed = parseAllowedMethods(props.value);
  return parsed ? createElement(AllowedMethodsContext.Provider, { value: parsed }, props.children) : (props.children as never);
}
