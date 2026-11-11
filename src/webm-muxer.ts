type Encoded = { data: Uint8Array; timestamp: number; key: boolean };
const bytes = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0)); let at=0; for(const p of parts){out.set(p,at);at+=p.length} return out };
const num = (value:number, length:number) => { const out=new Uint8Array(length); for(let i=length-1;i>=0;i--){out[i]=value&255;value=Math.floor(value/256)} return out };
const vint = (value:number) => { for(let n=1;n<=8;n++){const max=2**(7*n)-1;if(value<max){const out=num(value,n);out[0]|=1<<(8-n);return out}} throw new Error("EBML value too large") };
const id = (value:number) => { let n=1; while(value>=2**(8*n))n++; return num(value,n) };
const element = (tag:number, data:Uint8Array) => bytes(id(tag),vint(data.length),data);
const uint = (tag:number,value:number) => { let n=1; while(value>=2**(8*n))n++; return element(tag,num(value,n)) };
const text = (tag:number,value:string) => element(tag,new TextEncoder().encode(value));
const float64 = (tag:number,value:number) => {const b=new ArrayBuffer(8);new DataView(b).setFloat64(0,value);return element(tag,new Uint8Array(b))};
const master = (tag:number,...children:Uint8Array[]) => element(tag,bytes(...children));

export class WebMMuxer {
  private frames: Encoded[]=[];
  constructor(private width:number,private height:number,private codec:"V_VP8"|"V_VP9",private durationSeconds:number){}
  add(chunk:EncodedVideoChunk){const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);this.frames.push({data,timestamp:chunk.timestamp,key:chunk.type==="key"})}
  finalize(){
    const ebml=master(0x1a45dfa3,uint(0x4286,1),uint(0x42f7,1),uint(0x42f2,4),uint(0x42f3,8),text(0x4282,"webm"),uint(0x4287,2),uint(0x4285,2));
    const info=master(0x1549a966,uint(0x2ad7b1,1_000_000),float64(0x4489,this.durationSeconds*1000),text(0x4d80,"Video to ASCII"),text(0x5741,"Video to ASCII"));
    const video=master(0xe0,uint(0xb0,this.width),uint(0xba,this.height));
    const tracks=master(0x1654ae6b,master(0xae,uint(0xd7,1),uint(0x73c5,1),uint(0x83,1),text(0x86,this.codec),video));
    const clusters:Uint8Array[]=[]; let group:Encoded[]=[]; let base=0;
    const flush=()=>{if(!group.length)return;const blocks=group.map(f=>{const rel=Math.round(f.timestamp/1000)-base;const header=bytes(vint(1),num(rel<0?65536+rel:rel,2),new Uint8Array([f.key?0x80:0]));return element(0xa3,bytes(header,f.data))});clusters.push(master(0x1f43b675,uint(0xe7,base),...blocks));group=[]};
    for(const frame of this.frames){const ms=Math.round(frame.timestamp/1000);if(!group.length)base=ms;if(ms-base>30000){flush();base=ms}group.push(frame)}flush();
    return new Blob([ebml,master(0x18538067,info,tracks,...clusters)],{type:"video/webm"});
  }
}
