import {describe,expect,it} from "vitest";
import {AdaptiveQuality,percentile,selectQuality} from "./quality";
describe("automatic quality",()=>{
  it("uses elevated percentiles and enforces the budget",()=>{expect(percentile([1,2,3,100],.95)).toBe(100);expect(selectQuality([{columns:100,mode:"balanced",smoothing:.5,score:.5,meanMs:3,p95Ms:4,bytes:10},{columns:200,mode:"fast",smoothing:.5,score:.9,meanMs:30,p95Ms:40,bytes:10}],30,100)?.columns).toBe(100)});
  it("uses hysteresis before upgrading",()=>{const q=new AdaptiveQuality(1,3);for(let window=0;window<2;window++)for(let i=0;i<90;i++)expect(q.observe(1,16)).toBe(0);let changed=0;for(let i=0;i<90;i++)changed+=q.observe(1,16);expect(changed).toBe(1);expect(q.level).toBe(2)});
  it("downgrades sustained slow rendering",()=>{const q=new AdaptiveQuality(2,3);let change=0;for(let i=0;i<90;i++)change+=q.observe(30,16);expect(change).toBe(-1);expect(q.level).toBe(1)});
});
