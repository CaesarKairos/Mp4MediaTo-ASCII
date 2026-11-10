export type RGB={r:number;g:number;b:number};
export type Cell={glyph:string;foreground:RGB;background?:RGB};
export type Mode='fast'|'balanced'|'high'|'edge'|'braille';
export type Dither='none'|'ordered'|'floyd';
export interface Settings{columns:number;mode:Mode;charset:string;color:string;brightness:number;contrast:number;gamma:number;invert:boolean;dither:Dither;smoothing:number;hysteresis:number;edgeWeight:number;background:RGB}
