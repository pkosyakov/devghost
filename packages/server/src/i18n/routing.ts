import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'ru'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
  alternateLinks: true,
});

export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;
