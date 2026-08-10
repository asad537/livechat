import React from 'react';
import { classNames, initials } from '../util';

interface Props {
  name: string | null | undefined;
  color: string;
  url?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xs';
  className?: string;
}

/** Agent/user avatar: profile picture when set, colored initials otherwise. */
export default function Avatar({ name, color, url, size = 'md', className }: Props) {
  const cls = classNames(
    'avatar',
    size === 'sm' && 'avatar-sm',
    size === 'lg' && 'avatar-lg',
    size === 'xs' && 'avatar-xs',
    className,
  );
  if (url) {
    return <img className={classNames(cls, 'avatar-img')} src={url} alt={name ?? 'avatar'} />;
  }
  return (
    <span className={cls} style={{ background: color }}>
      {initials(name)}
    </span>
  );
}
