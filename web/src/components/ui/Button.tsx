import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';
import '@assets/styles/admin/ui/button.scss';

type ButtonProps = {
  children: ReactNode;
  variation?: 'default' | 'active' | 'inactive'; // Add more if needed
  as?: 'button' | 'a';
  href?: string; // Only used when `as === 'a'`
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'type'> & {
    type?: 'button' | 'submit' | 'reset';
  };

const Button = ({
  children,
  variation = 'default',
  as = 'button',
  href,
  type = 'button',
  className = '',
  ...props
}: ButtonProps) => {
  const classNames = `button ${variation} ${className}`;

  if (as === 'a' && href) {
    return (
      <a href={href} className={classNames} {...(props as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  }

  return (
    <button type={type} className={classNames} {...(props as ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
};

export default Button;
