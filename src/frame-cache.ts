export type CachedFrame={bitmap:ImageBitmap;width:number;height:number;rows:number;count:number};

type Entry=CachedFrame&{bytes:number;lastUsed:number};

export class FrameCache{
 private entries=new Map<string,Entry>();
 private usedBytes=0;
 constructor(private readonly maxBytes=128*1024*1024,private readonly ttlMs=5*60*1000,private readonly now=()=>Date.now()){}
 get size(){return this.entries.size}
 get bytes(){return this.usedBytes}
 get(key:string){const entry=this.entries.get(key);if(!entry)return;const now=this.now();if(now-entry.lastUsed>=this.ttlMs){this.remove(key,entry);return}entry.lastUsed=now;this.entries.delete(key);this.entries.set(key,entry);return entry as CachedFrame}
 set(key:string,frame:CachedFrame){const existing=this.entries.get(key);if(existing)this.remove(key,existing);const bytes=frame.width*frame.height*4;if(bytes>this.maxBytes){frame.bitmap.close();return}const entry={...frame,bytes,lastUsed:this.now()};this.entries.set(key,entry);this.usedBytes+=bytes;this.prune();while(this.usedBytes>this.maxBytes){const oldest=this.entries.entries().next().value as [string,Entry]|undefined;if(!oldest)break;this.remove(oldest[0],oldest[1])}}
 prune(){const now=this.now();for(const [key,entry] of this.entries)if(now-entry.lastUsed>=this.ttlMs)this.remove(key,entry)}
 clear(){for(const entry of this.entries.values())entry.bitmap.close();this.entries.clear();this.usedBytes=0}
 private remove(key:string,entry:Entry){this.entries.delete(key);this.usedBytes-=entry.bytes;entry.bitmap.close()}
}
