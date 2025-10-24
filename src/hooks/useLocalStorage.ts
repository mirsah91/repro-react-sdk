import { useCallback, useEffect, useState } from 'react';

export function useLocalStorage<T>(key: string, defaultValue: T | (() => T)) {
  const readValue = useCallback(() => {
    if (typeof window === 'undefined') {
      return defaultValue instanceof Function ? defaultValue() : defaultValue;
    }

    const stored = window.localStorage.getItem(key);
    if (stored) {
      try {
        return JSON.parse(stored) as T;
      } catch (error) {
        console.warn(`Failed to parse localStorage value for "${key}"`, error);
      }
    }

    return defaultValue instanceof Function ? defaultValue() : defaultValue;
  }, [defaultValue, key]);

  const [value, setValue] = useState<T>(() => readValue());

  useEffect(() => {
    setValue(readValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const setStoredValue = useCallback(
    (newValue: T | ((prev: T) => T)) => {
      setValue((current) => {
        const resolved = newValue instanceof Function ? newValue(current) : newValue;
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(key, JSON.stringify(resolved));
        }
        return resolved;
      });
    },
    [key]
  );

  const remove = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(key);
    }
    setValue(defaultValue instanceof Function ? defaultValue() : defaultValue);
  }, [defaultValue, key]);

  return { value, setValue: setStoredValue, remove } as const;
}
