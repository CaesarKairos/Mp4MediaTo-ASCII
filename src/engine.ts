import type {Cell,Dither,RGB,Settings} from './types';
export const CHARSETS={classic:' .:-=+*#%@',detailed:' `.^",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',blocks:' ░▒▓█',binary:' 01'};
export const PALETTES:Record<string,RGB[]|null>={original:null,mono:[{r:255,g:255,b:255}],green:[{r:5,g:46,b:22},{r:22,g:101,b:52},{r:34,g:197,b:94},{r:187,g:247,b:208}],amber:[{r:45,g:25,b:0},{r:146,g:64,b:14},{r:245,g:158,b:11},{r:254,g:243,b:199}],gameboy:[{r:15,g:56,b:15},{r:48,g:98,b:48},{r:139,g:172,b:15},{r:155,g:188,b:15}],purple:[{r:0,g:0,b:0},{r:168,g:85,b:247},{r:34,g:197,b:94},{r:255,g:255,b:255}],red:[{r:0,g:0,b:0},{r:127,g:29,b:29},{r:239,g:68,b:68},{r:254,g:202,b:202}],cyan:[{r:0,g:0,b:0},{r:8,g:145,b:178},{r:34,g:211,b:238},{r:207,g:250,b:254}],bw:[{r:0,g:0,b:0},{r:255,g:255,b:255}]};
export const luminance=(r:number,g:number,b:number)=>0.2126*r+0.7152*g+0.0722*b;
export function rowsFor(w:number,h:number,columns:number,cellW=8,cellH=16){return Math.max(1,Math.round(columns*(h/w)*(cellW/cellH)))}
export function quantize(c:RGB,palette:RGB[]|null){if(!palette)return c;let best=palette[0],d=Infinity;for(const p of palette){const n=(c.r-p.r)**2+(c.g-p.g)**2+(c.b-p.b)**2;if(n<d){d=n;best=p}}return best}
export function braille(bits:boolean[]){let code=0;const map=[0,1,2,6,3,4,5,7];bits.forEach((v,i)=>{if(v)code|=1<<map[i]});return String.fromCodePoint(0x2800+code)}
const clamp=(v:number)=>Math.max(0,Math.min(255,v));
const bayer=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
export class AsciiEngine{
 private previous:number[]=[];private previousGlyph:string[]=[];
 reset(){this.previous=[];this.previousGlyph=[]}
 convert(data:ImageData,s:Settings):{cells:Cell[];rows:number}{
  const {width:w,height:h}=data,rows=rowsFor(w,h,s.columns),cw=w/s.columns,ch=h/rows,cells:Cell[]=[],levels=s.charset.length-1,next:number[]=[];
  for(let gy=0;gy<rows;gy++)for(let gx=0;gx<s.columns;gx++){
   let rr=0,gg=0,bb=0,count=0,min=255,max=0;const sx=Math.max(1,Math.floor(cw/3)),sy=Math.max(1,Math.floor(ch/3));
   for(let y=Math.floor(gy*ch);y<Math.min(h,Math.ceil((gy+1)*ch));y+=sy)for(let x=Math.floor(gx*cw);x<Math.min(w,Math.ceil((gx+1)*cw));x+=sx){const i=(y*w+x)*4,a=data.data[i+3]/255;const r=data.data[i]*a+s.background.r*(1-a),g=data.data[i+1]*a+s.background.g*(1-a),b=data.data[i+2]*a+s.background.b*(1-a);rr+=r;gg+=g;bb+=b;const l=luminance(r,g,b);min=Math.min(min,l);max=Math.max(max,l);count++}
   rr/=count;gg/=count;bb/=count;let l=luminance(rr,gg,bb);l=clamp((Math.pow(clamp((l-127.5)*s.contrast+127.5+s.brightness*255)/255,s.gamma))*255);if(s.invert)l=255-l;
   if(s.dither==='ordered')l=clamp(l+(bayer[(gy%4)*4+gx%4]/15-.5)*40);
   const idx=gy*s.columns+gx,prev=this.previous[idx];if(prev!==undefined){const motion=Math.abs(l-prev);if(motion<48)l=s.smoothing*l+(1-s.smoothing)*prev}next[idx]=l;
   let glyph:string;if(s.mode==='braille'){const bits=Array.from({length:8},(_,k)=>l+(k%2?max-min:0)>((k+1)/9)*255);glyph=braille(bits)}else{let density=l/255;if(s.mode==='edge')density=Math.min(1,density+(max-min)/255*s.edgeWeight);let gi=Math.round(density*levels);const old=this.previousGlyph[idx];if(old){const oi=s.charset.indexOf(old),gain=Math.abs(gi-oi)/Math.max(1,levels);if(gain<s.hysteresis)gi=oi}glyph=s.charset[gi]??' '}
   this.previousGlyph[idx]=glyph;cells.push({glyph,foreground:quantize({r:Math.round(rr),g:Math.round(gg),b:Math.round(bb)},PALETTES[s.color]??null),background:s.background});
  }this.previous=next;return{cells,rows}
 }
}
export function applyFloyd(values:number[],w:number,h:number,levels:number){const a=[...values];for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,old=a[i],q=Math.round(old*levels)/levels,e=old-q;a[i]=q;if(x+1<w)a[i+1]+=e*7/16;if(y+1<h){if(x)a[i+w-1]+=e*3/16;a[i+w]+=e*5/16;if(x+1<w)a[i+w+1]+=e/16}}return a}
