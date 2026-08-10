import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number | undefined, className: string | undefined, children: React.ReactNode, filled = false) {
  return (
    <svg
      width={size ?? 18}
      height={size ?? 18}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconInbox = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ));

export const IconUsers = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ));

export const IconEye = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ));

export const IconChart = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </>
  ));

export const IconSettings = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ));

export const IconPhone = ({ size, className }: IconProps) =>
  base(size, className, (
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  ));

export const IconPhoneOff = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="23" y1="1" x2="1" y2="23" />
    </>
  ));

export const IconVideo = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </>
  ));

export const IconVideoOff = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </>
  ));

export const IconMic = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </>
  ));

export const IconMicOff = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </>
  ));

export const IconTransfer = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <polyline points="17 1 21 5 17 9" />
      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
      <polyline points="7 23 3 19 7 15" />
      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    </>
  ));

export const IconX = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ));

export const IconCheck = ({ size, className }: IconProps) =>
  base(size, className, <polyline points="20 6 9 17 4 12" />);

/** Double tick for delivered/read receipts. */
export const IconDoubleCheck = ({ size, className }: IconProps) => (
  <svg
    width={size ?? 14}
    height={size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="2 13 6.5 17.5 15 8" />
    <polyline points="10.5 15.5 12.5 17.5 22 7" />
  </svg>
);

export const IconSingleCheck = ({ size, className }: IconProps) => (
  <svg
    width={size ?? 14}
    height={size ?? 14}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="5 13 9.5 17.5 19 7" />
  </svg>
);

export const IconSend = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </>
  ));

export const IconPaperclip = ({ size, className }: IconProps) =>
  base(size, className, (
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  ));

export const IconFile = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </>
  ));

export const IconDownload = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ));

export const IconLogout = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ));

export const IconPlus = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ));

export const IconCopy = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ));

export const IconUserPlus = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </>
  ));

export const IconMessage = ({ size, className }: IconProps) =>
  base(size, className, (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ));

export const IconGlobe = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ));

export const IconClock = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ));

/** App logo mark shown in the sidebar. */
export const LogoMark = ({ size }: { size?: number }) => (
  <svg width={size ?? 28} height={size ?? 28} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#6366f1" />
    <path
      d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H14l-4 4v-4.4A3.5 3.5 0 0 1 9 16.5v-5z"
      fill="#fff"
    />
    <circle cx="13" cy="14" r="1.3" fill="#6366f1" />
    <circle cx="16.5" cy="14" r="1.3" fill="#6366f1" />
    <circle cx="20" cy="14" r="1.3" fill="#6366f1" />
  </svg>
);

export const IconExpand = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </>
  ));

export const IconSearch = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </>
  ));

// ─── Brand marks (filled, multi-color) — device chips ────────
export const IconChrome = ({ size = 13 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="#fff" />
    <path d="M12 12 2.47 6.5a11 11 0 0 1 19.06 0z" fill="#EA4335" />
    <path d="M12 12 2.47 6.5A11 11 0 0 0 12 23z" fill="#34A853" />
    <path d="M12 12v11a11 11 0 0 0 9.53-16.5z" fill="#FBBC05" />
    <circle cx="12" cy="12" r="5" fill="#fff" />
    <circle cx="12" cy="12" r="3.8" fill="#4285F4" />
  </svg>
);

export const IconApple = ({ size = 13 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M16.7 12.9c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.9-1.6 0-3.2 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3.1 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.6-1-2.7-3.8zM14.4 5.4c.7-.8 1.1-1.9 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z"
      fill="#3f3f46"
    />
  </svg>
);

export const IconWindows = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#00ADEF"
      d="M3 5.5l7.5-1v7H3zM11.5 4.3L21 3v8.5h-9.5zM3 13.5h7.5v7L3 19.5zM11.5 13.5H21V21l-9.5-1.3z"
    />
  </svg>
);

export const IconAndroid = ({ size = 13 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="#3DDC84"
      d="M17.5 8.6l1.5-2.6a.4.4 0 0 0-.7-.4l-1.5 2.7a9.6 9.6 0 0 0-9.6 0L5.7 5.6a.4.4 0 0 0-.7.4l1.5 2.6A9 9 0 0 0 2 16h20a9 9 0 0 0-4.5-7.4z"
    />
    <circle cx="7.7" cy="12.6" r="1" fill="#fff" />
    <circle cx="16.3" cy="12.6" r="1" fill="#fff" />
  </svg>
);

export const IconBriefcase = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </>
  ));

export const IconWorkflow = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="5" cy="5" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <circle cx="7" cy="19" r="2.5" />
      <path d="M7.4 6.8 16.7 11M16.6 13.4 9.2 17.6" />
    </>
  ));

export const IconPlug = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M9 7V2M15 7V2" />
      <path d="M6 7h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
      <path d="M12 17v5" />
    </>
  ));

export const IconHome = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M10 21v-6h4v6" />
    </>
  ));

export const IconStar = ({ size, className }: IconProps) =>
  base(size, className, (
    <path d="M12 2.5l2.9 5.9 6.5.95-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.05 1.1-6.5-4.7-4.6 6.5-.95z" />
  ));

export const IconCheckCircle = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M8 12.5l2.6 2.6L16 9.5" />
    </>
  ));

export const IconAlert = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <path d="M12 3 2.5 20h19z" />
      <line x1="12" y1="9.5" x2="12" y2="14" />
      <circle cx="12" cy="17" r="0.6" />
    </>
  ));

export const IconUser = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ));

export const IconCalendar = ({ size, className }: IconProps) =>
  base(size, className, (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </>
  ));
