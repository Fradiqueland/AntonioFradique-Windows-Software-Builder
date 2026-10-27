'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const RE=require('resedit'),{brandExecutable,iconFileBytes}=require('../src/shared/windows-pe');
test('Windows executable branding replaces all icon groups and product names without changing code',async()=>{
 const exe=RE.NtExecutable.createEmpty(false,false),res=RE.NtExecutableResource.from(exe);
 const manifest=Buffer.from('<assembly>preserved manifest</assembly>');res.entries.push({type:24,id:1,lang:1033,codepage:0,bin:manifest.buffer.slice(manifest.byteOffset,manifest.byteOffset+manifest.byteLength)});res.outputResource(exe);
 const ico=await iconFileBytes({absolute:path.join(__dirname,'../src/builder/app-icon.png')});
 const output=brandExecutable(Buffer.from(exe.generate()),{name:'António Software',icoBytes:ico});
 const parsed=RE.NtExecutable.from(output),resources=RE.NtExecutableResource.from(parsed);
 const groups=RE.Resource.IconGroupEntry.fromEntries(resources.entries);assert.equal(groups.length,1);assert.ok(groups[0].getIconItemsFromEntries(resources.entries).length>0);
 const version=RE.Resource.VersionInfo.fromEntries(resources.entries)[0];assert.equal(version.getStringValues({lang:1033,codepage:1200}).OriginalFilename,'António Software.exe');
 assert.deepEqual(Buffer.from(resources.entries.find(e=>e.type===24).bin),manifest);
 const twice=brandExecutable(output,{name:'Changed name',icoBytes:ico});const next=RE.NtExecutableResource.from(RE.NtExecutable.from(twice));assert.equal(RE.Resource.IconGroupEntry.fromEntries(next.entries).length,1);
});
