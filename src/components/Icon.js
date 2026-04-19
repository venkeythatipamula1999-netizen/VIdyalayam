import React from 'react';
import Svg, { Path, Circle, Rect, Line, Polyline, Polygon } from 'react-native-svg';

export default function Icon({ name, size = 20, color = '#FFFFFF' }) {
  const props = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' };
  const sp = { stroke: color, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

  switch (name) {
    case 'home':
      return <Svg {...props}><Path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" {...sp} /><Polyline points="9 22 9 12 15 12 15 22" {...sp} /></Svg>;
    case 'users':
      return <Svg {...props}><Path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" {...sp} /><Circle cx={9} cy={7} r={4} {...sp} /><Path d="M23 21v-2a4 4 0 00-3-3.87" {...sp} /><Path d="M16 3.13a4 4 0 010 7.75" {...sp} /></Svg>;
    case 'bell':
      return <Svg {...props}><Path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" {...sp} /><Path d="M13.73 21a2 2 0 01-3.46 0" {...sp} /></Svg>;
    case 'map':
      return <Svg {...props}><Polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" {...sp} /><Line x1={8} y1={2} x2={8} y2={18} {...sp} /><Line x1={16} y1={6} x2={16} y2={22} {...sp} /></Svg>;
    case 'book':
      return <Svg {...props}><Path d="M4 19.5A2.5 2.5 0 016.5 17H20" {...sp} /><Path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" {...sp} /></Svg>;
    case 'chart':
      return <Svg {...props}><Line x1={18} y1={20} x2={18} y2={10} {...sp} /><Line x1={12} y1={20} x2={12} y2={4} {...sp} /><Line x1={6} y1={20} x2={6} y2={14} {...sp} /></Svg>;
    case 'check':
      return <Svg {...props}><Polyline points="20 6 9 17 4 12" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
    case 'arrow':
      return <Svg {...props}><Line x1={5} y1={12} x2={19} y2={12} {...sp} /><Polyline points="12 5 19 12 12 19" {...sp} /></Svg>;
    case 'back':
      return <Svg {...props}><Polyline points="15 18 9 12 15 6" {...sp} /></Svg>;
    case 'bus':
      return <Svg {...props}><Rect x={1} y={3} width={15} height={13} {...sp} /><Polygon points="16 8 20 8 23 11 23 16 16 16 16 8" {...sp} /><Circle cx={5.5} cy={18.5} r={2.5} {...sp} /><Circle cx={18.5} cy={18.5} r={2.5} {...sp} /></Svg>;
    case 'star':
      return <Svg {...props}><Polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill={color} stroke={color} strokeWidth={1.5} /></Svg>;
    case 'info':
      return <Svg {...props}><Circle cx={12} cy={12} r={10} {...sp} /><Line x1={12} y1={16} x2={12} y2={12} {...sp} /><Line x1={12} y1={8} x2={12.01} y2={8} {...sp} /></Svg>;
    case 'phone':
      return <Svg {...props}><Path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.67A2 2 0 012.18 1h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L6.91 8.09a16 16 0 006 6l1.45-1.45a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14.92z" {...sp} /></Svg>;
    case 'mail':
      return <Svg {...props}><Path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" {...sp} /><Polyline points="22,6 12,13 2,6" {...sp} /></Svg>;
    case 'location':
      return <Svg {...props}><Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" {...sp} /><Circle cx={12} cy={10} r={3} {...sp} /></Svg>;
    case 'qr':
      return <Svg {...props}><Rect x={3} y={3} width={7} height={7} {...sp} /><Rect x={14} y={3} width={7} height={7} {...sp} /><Rect x={3} y={14} width={7} height={7} {...sp} /><Rect x={14} y={14} width={3} height={3} {...sp} /></Svg>;
    case 'trend':
      return <Svg {...props}><Polyline points="23 6 13.5 15.5 8.5 10.5 1 18" {...sp} /><Polyline points="17 6 23 6 23 12" {...sp} /></Svg>;
    case 'search':
      return <Svg {...props}><Circle cx={11} cy={11} r={8} {...sp} /><Line x1={21} y1={21} x2={16.65} y2={16.65} {...sp} /></Svg>;
    case 'grid':
      return <Svg {...props}><Rect x={3} y={3} width={7} height={7} {...sp} /><Rect x={14} y={3} width={7} height={7} {...sp} /><Rect x={3} y={14} width={7} height={7} {...sp} /><Rect x={14} y={14} width={7} height={7} {...sp} /></Svg>;
    case 'fee':
      return <Svg {...props}><Line x1={12} y1={1} x2={12} y2={23} {...sp} /><Path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" {...sp} /></Svg>;
    case 'leave':
      return <Svg {...props}><Path d="M12 3c-1.5 2-4 3.5-7 3.5" {...sp} /><Path d="M12 3c1.5 2 4 3.5 7 3.5" {...sp} /><Path d="M12 3c-1 2.5-1 5-1 8" {...sp} /><Path d="M12 3c1 2.5 1 5 1 8" {...sp} /><Line x1={12} y1={3} x2={12} y2={21} {...sp} /><Path d="M7 21h10" {...sp} /><Circle cx={19} cy={5} r={2} fill={color} stroke={color} strokeWidth={1} /></Svg>;
    case 'scan':
      return <Svg {...props}><Rect x={3} y={3} width={7} height={7} {...sp} /><Rect x={14} y={3} width={7} height={7} {...sp} /><Rect x={3} y={14} width={7} height={7} {...sp} /><Rect x={14} y={14} width={3} height={3} {...sp} /></Svg>;
    case 'clock':
      return <Svg {...props}><Circle cx={12} cy={12} r={10} {...sp} /><Polyline points="12 6 12 12 16 14" {...sp} /></Svg>;
    case 'user':
      return <Svg {...props}><Path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" {...sp} /><Circle cx={12} cy={7} r={4} {...sp} /></Svg>;
    case 'navigate':
      return <Svg {...props}><Polygon points="3 11 22 2 13 21 11 13 3 11" {...sp} /></Svg>;
    case 'alert':
      return <Svg {...props}><Path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" {...sp} /><Line x1={12} y1={9} x2={12} y2={13} {...sp} /><Line x1={12} y1={17} x2={12.01} y2={17} {...sp} /></Svg>;
    case 'flash':
      return <Svg {...props}><Polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill={color} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
    case 'cam':
      return <Svg {...props}><Path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" {...sp} /><Circle cx={12} cy={13} r={4} {...sp} /></Svg>;
    case 'x':
      return <Svg {...props}><Line x1={18} y1={6} x2={6} y2={18} stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /><Line x1={6} y1={6} x2={18} y2={18} stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" /></Svg>;
    case 'download':
      return <Svg {...props}><Path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" {...sp} /><Polyline points="7 10 12 15 17 10" {...sp} /><Line x1={12} y1={15} x2={12} y2={3} {...sp} /></Svg>;
    case 'lock':
      return <Svg {...props}><Rect x={3} y={11} width={18} height={11} rx={2} ry={2} {...sp} /><Path d="M7 11V7a5 5 0 0110 0v4" {...sp} /></Svg>;
    case 'logout':
      return <Svg {...props}><Path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" {...sp} /><Polyline points="16 17 21 12 16 7" {...sp} /><Line x1={21} y1={12} x2={9} y2={12} {...sp} /></Svg>;
    default:
      return null;
  }
}
