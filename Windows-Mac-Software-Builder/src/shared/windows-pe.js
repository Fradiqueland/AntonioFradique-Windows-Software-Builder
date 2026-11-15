'use strict';
// Builder-only PE editing is pure JavaScript, so a Mac can also export a named,
// icon-branded Windows program without Wine or native Windows tools.
async function iconFileBytes(icon) {
  const fs=process.versions.electron?require('original-fs'):require('fs');
  const path=require('path');
  if(path.extname(icon.absolute).toLowerCase()==='.ico')return fs.readFileSync(icon.absolute);
  if(process.versions.electron){
    const image=require('electron').nativeImage.createFromPath(icon.absolute);
    if(image.isEmpty())throw new Error('Imagem de ícone inválida.');
    return require('./project-icon').imageToIco(image);
  }
  if(path.extname(icon.absolute).toLowerCase()==='.png')return require('png-to-ico')(icon.absolute);
  throw new Error('A conversão de JPG requer o construtor Electron. Use PNG ou ICO.');
}
function brandExecutable(bytes,{name,icoBytes}) {
  const ResEdit=require('resedit');
  const executable=ResEdit.NtExecutable.from(bytes,{ignoreCert:true});
  const resources=ResEdit.NtExecutableResource.from(executable);
  if(icoBytes){
    const frames=ResEdit.Data.IconFile.from(icoBytes).icons.map(frame=>frame.data);
    if(!frames.length)throw new Error('O ícone não contém imagens.');
    const groups=ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
    for(const group of groups.length?groups:[{id:1,lang:1033}])ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries,group.id,group.lang,frames);
  }
  const existing=ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  for(const version of existing.length?existing:[ResEdit.Resource.VersionInfo.createEmpty()]){
    const languages=version.getAllLanguagesForStringValues();
    for(const language of languages.length?languages:[{lang:1033,codepage:1200}])version.setStringValues(language,{FileDescription:name,ProductName:name,InternalName:name,OriginalFilename:name+'.exe'});
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}
module.exports={brandExecutable,iconFileBytes};
