import test from 'node:test';import assert from 'node:assert/strict';import {mc,resetWorld,load} from '../lib/civharness.mjs';
const {createRealmClaimRegistry,resolveRealmBuilderContext}=await load('civ','realmSources.js');
function fixture(){resetWorld();const r=createRealmClaimRegistry(mc.world,{capturePlayerProtection:()=>({complete:true,areas:[]})});r.reserve('realm-1',{x0:100,z0:100,x1:200,z1:200});return r;}
const key='civ:realm:realm-1:jobs:probe';
for(const [name,value]of [['NaN',NaN],['positiveInfinity',Infinity],['negativeInfinity',-Infinity]]){
 test('initial corrupt own '+name+' refuses capture without writes',()=>{const r=fixture();mc.props.set(key,value);const before=new Map(mc.props),writes=mc.propWrites;assert.throws(()=>resolveRealmBuilderContext(r.builderContext('realm-1'),mc.world,1).readFence(),/own realm source unreadable/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes)});
 test('late corrupt own '+name+' refuses a previously valid read fence without writes',()=>{const r=fixture();mc.props.set(key,17);const c=resolveRealmBuilderContext(r.builderContext('realm-1'),mc.world,1).readFence();c();mc.props.set(key,value);const before=new Map(mc.props),writes=mc.propWrites;assert.throws(c,/own realm source unreadable/);assert.deepEqual(mc.props,before);assert.equal(mc.propWrites,writes)});
 test('existing external '+name+' remains refused identically',()=>{const r=fixture();mc.props.set('civ:plan:probe',value);assert.throws(()=>r.builderContext('realm-1'),/source raw property unreadable/)});
}
test('finite signed numbers remain readable and changed signs are detected',()=>{const r=fixture();mc.props.set(key,-17);const c=resolveRealmBuilderContext(r.builderContext('realm-1'),mc.world,1).readFence();c();mc.props.set(key,17);assert.throws(c,/source changed/)});
test('booleans and strings retain exact type-sensitive comparison',()=>{const r=fixture();mc.props.set(key,false);const c=resolveRealmBuilderContext(r.builderContext('realm-1'),mc.world,1).readFence();c();mc.props.set(key,'false');assert.throws(c,/source changed/)});
