import { Toaster as Sonner, type ToasterProps } from 'sonner';

// shadcn's `sonner` component. The stock generated wrapper reads the theme from `next-themes`, which
// this app doesn't use — `theme="system"` follows the OS light/dark preference instead. `richColors`
// gives error/success toasts their semantic colors.
const Toaster = (props: ToasterProps) => (
  <Sonner theme="system" richColors position="bottom-right" {...props} />
);

export { Toaster };
