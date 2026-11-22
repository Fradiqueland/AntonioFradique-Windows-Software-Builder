// Self-contained Win32 bootstrap. Warm starts read only the fixed-size footer,
// inspect completion markers and start the retained Viewer. No shell, PowerShell,
// installed runtime, elevated permission or whole-payload scan is used.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <bcrypt.h>
#include <commctrl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <string.h>

#define PATH_CHARS 32768
#define FOOTER_BYTES 256
static const unsigned char MAGIC[16]={'W','S','M','B','-','L','A','U','N','C','H','-','V','1',0,0};
typedef struct Bundle {
  wchar_t *self, *base, *root, *stage;
  unsigned char footer[FOOTER_BYTES];
  uint64_t stubBytes, extractorBytes, archiveBytes, payloadRead;
  wchar_t key[65];
  DWORD error, prepareMs;
  BOOL cacheHit, extractorStillRunning;
  volatile LONG cancel;
} Bundle;
static wchar_t *allocate_path(void) { return (wchar_t *)calloc(PATH_CHARS,sizeof(wchar_t)); }
static wchar_t *joined(const wchar_t *base,const wchar_t *relative) {
  wchar_t *out=allocate_path();
  if(!out)return NULL;
  if(swprintf_s(out,PATH_CHARS,L"%s\\%s",base,relative)<0){free(out);return NULL;}
  return out;
}
static BOOL normal_directory(const wchar_t *p) {
  DWORD a=GetFileAttributesW(p);
  return a!=INVALID_FILE_ATTRIBUTES&&(a&FILE_ATTRIBUTE_DIRECTORY)&&!(a&FILE_ATTRIBUTE_REPARSE_POINT);
}
static BOOL normal_file(const wchar_t *p) {
  WIN32_FILE_ATTRIBUTE_DATA data;
  return GetFileAttributesExW(p,GetFileExInfoStandard,&data)&&
    !(data.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&
    (data.nFileSizeHigh||data.nFileSizeLow);
}
static BOOL make_directory(const wchar_t *p) {
  return CreateDirectoryW(p,NULL)?TRUE:normal_directory(p);
}
// Only private staging/incomplete digest directories are removed. Never follow
// a junction or symlink out of those directories.
static wchar_t *filesystem_path(const wchar_t *p) {
  wchar_t *out=allocate_path();if(!out)return NULL;
  if(!wcsncmp(p,L"\\\\?\\",4)){wcscpy_s(out,PATH_CHARS,p);return out;}
  if(!wcsncmp(p,L"\\\\",2))swprintf_s(out,PATH_CHARS,L"\\\\?\\UNC\\%s",p+2);
  else if(wcslen(p)>2&&p[1]==L':')swprintf_s(out,PATH_CHARS,L"\\\\?\\%s",p);
  else wcscpy_s(out,PATH_CHARS,p);
  return out;
}
static BOOL remove_tree_namespaced(const wchar_t *p) {
  DWORD a=GetFileAttributesW(p);BOOL ok=TRUE;WIN32_FIND_DATAW data;HANDLE find;
  wchar_t *pattern,*child;
  if(a==INVALID_FILE_ATTRIBUTES)return GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND;
  if(a&FILE_ATTRIBUTE_REPARSE_POINT)return (a&FILE_ATTRIBUTE_DIRECTORY)?RemoveDirectoryW(p):DeleteFileW(p);
  if(!(a&FILE_ATTRIBUTE_DIRECTORY)){SetFileAttributesW(p,FILE_ATTRIBUTE_NORMAL);return DeleteFileW(p);}
  pattern=joined(p,L"*");if(!pattern)return FALSE;
  find=FindFirstFileW(pattern,&data);free(pattern);
  if(find!=INVALID_HANDLE_VALUE){do {
    if(!wcscmp(data.cFileName,L".")||!wcscmp(data.cFileName,L".."))continue;
    child=joined(p,data.cFileName);if(!child){ok=FALSE;break;}
    if(!remove_tree_namespaced(child))ok=FALSE;free(child);
  }while(FindNextFileW(find,&data));FindClose(find);}
  return ok&&RemoveDirectoryW(p);
}
static BOOL remove_tree(const wchar_t *p) {
  wchar_t *extended=filesystem_path(p);BOOL ok;DWORD error;
  if(!extended)return FALSE;ok=remove_tree_namespaced(extended);error=GetLastError();free(extended);SetLastError(error);return ok;
}
static HANDLE open_bundle(const wchar_t *p,BOOL sequential) {
  wchar_t *extended=filesystem_path(p);HANDLE file;DWORD error;
  if(!extended)return INVALID_HANDLE_VALUE;
  file=CreateFileW(extended,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL|(sequential?FILE_FLAG_SEQUENTIAL_SCAN:FILE_FLAG_RANDOM_ACCESS),NULL);
  error=GetLastError();free(extended);SetLastError(error);return file;
}
static BOOL digest_memory(const unsigned char *bytes,ULONG count,unsigned char result[32]) {
  BCRYPT_ALG_HANDLE algorithm=NULL;BCRYPT_HASH_HANDLE hash=NULL;BOOL ok=FALSE;
  if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,NULL,0)<0)return FALSE;
  if(BCryptCreateHash(algorithm,&hash,NULL,0,NULL,0,0)>=0&&BCryptHashData(hash,(PUCHAR)bytes,count,0)>=0&&BCryptFinishHash(hash,result,32,0)>=0)ok=TRUE;
  if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);return ok;
}
static uint64_t read_u64(const unsigned char *p){uint64_t n;memcpy(&n,p,8);return n;}
static uint32_t read_u32(const unsigned char *p){uint32_t n;memcpy(&n,p,4);return n;}
static BOOL read_footer(Bundle *b) {
  HANDLE file;LARGE_INTEGER size,pos;DWORD count;unsigned char digest[32];size_t i;
  file=open_bundle(b->self,FALSE);
  if(file==INVALID_HANDLE_VALUE)return FALSE;
  if(!GetFileSizeEx(file,&size)||size.QuadPart<FOOTER_BYTES){CloseHandle(file);return FALSE;}
  pos.QuadPart=size.QuadPart-FOOTER_BYTES;
  if(!SetFilePointerEx(file,pos,NULL,FILE_BEGIN)||!ReadFile(file,b->footer,FOOTER_BYTES,&count,NULL)||count!=FOOTER_BYTES){CloseHandle(file);return FALSE;}
  CloseHandle(file);
  if(memcmp(b->footer,MAGIC,16)||read_u32(b->footer+16)!=1||read_u32(b->footer+20)!=FOOTER_BYTES||!digest_memory(b->footer,224,digest)||memcmp(digest,b->footer+224,32))return FALSE;
  b->stubBytes=read_u64(b->footer+24);b->extractorBytes=read_u64(b->footer+32);b->archiveBytes=read_u64(b->footer+40);
  if(!b->stubBytes||b->stubBytes>16*1024*1024ULL||!b->extractorBytes||b->extractorBytes>16*1024*1024ULL||!b->archiveBytes||b->archiveBytes>32*1024*1024*1024ULL||
    b->stubBytes+b->extractorBytes+b->archiveBytes+FOOTER_BYTES!=(uint64_t)size.QuadPart)return FALSE;
  for(i=0;i<32;i++)swprintf_s(b->key+2*i,65-2*i,L"%02x",(unsigned int)b->footer[80+i]);
  return TRUE;
}
static BOOL engine_ready(const wchar_t *root) {
  static const unsigned char magic[16]={'W','S','M','B','-','R','U','N','T','I','M','E','-','V','1',0};
  wchar_t *p=joined(root,L".wsmb-engine-files"),name[128];HANDLE file;
  unsigned char bytes[24+64*264];LARGE_INTEGER size;DWORD count,i,n;BOOL ok=FALSE;WIN32_FILE_ATTRIBUTE_DATA data;
  if(!p)return FALSE;
  file=CreateFileW(p,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);free(p);
  if(file==INVALID_HANDLE_VALUE)return FALSE;
  if(!GetFileSizeEx(file,&size)||size.QuadPart<24||size.QuadPart>(LONGLONG)sizeof(bytes))goto done;
  if(!ReadFile(file,bytes,(DWORD)size.QuadPart,&count,NULL)||count!=(DWORD)size.QuadPart||memcmp(bytes,magic,16))goto done;
  n=read_u32(bytes+16);if(!n||n>64||24+n*264!=count)goto done;
  for(i=0;i<n;i++) {
    const unsigned char *record=bytes+24+i*264;uint64_t expected=read_u64(record+256),actual;
    memcpy(name,record,256);
    if(!name[0]||name[127]||name[0]==L'\\'||wcschr(name,L':')||wcschr(name,L'/')||wcsstr(name,L"..")||!expected)goto done;
    p=joined(root,name);if(!p)goto done;
    {BOOL found=GetFileAttributesExW(p,GetFileExInfoStandard,&data)&&!(data.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT));free(p);if(!found)goto done;}
    actual=((uint64_t)data.nFileSizeHigh<<32)|data.nFileSizeLow;
    if(actual!=expected)goto done;
  }
  ok=TRUE;
done:
  CloseHandle(file);return ok;
}
static BOOL runtime_files_ready(const wchar_t *root) {
  wchar_t *p;size_t i;BOOL ok;
  const wchar_t *required[]={L"LaunchBox Viewer.exe",L"resources\\app.asar",L"resources\\data\\project-config.json",L"resources\\project-assets.json"};
  if(!engine_ready(root))return FALSE;
  for(i=0;i<sizeof(required)/sizeof(required[0]);i++){p=joined(root,required[i]);if(!p)return FALSE;ok=normal_file(p);free(p);if(!ok)return FALSE;}
  p=joined(root,L"resources\\project-assets.zip");if(!p)return FALSE;ok=normal_file(p);free(p);
  if(!ok){p=joined(root,L"resources\\dist-assets\\.wsmb-assets-ready.json");if(!p)return FALSE;ok=normal_file(p);free(p);}
  return ok;
}
static BOOL ready(Bundle *b) {
  wchar_t *p;HANDLE file;char receipt[64],expected[65];DWORD count;size_t i;BOOL ok=FALSE;
  if(!normal_directory(b->root))return FALSE;
  p=joined(b->root,L".wsmb-runtime-ready");if(!p)return FALSE;
  file=CreateFileW(p,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);free(p);
  if(file==INVALID_HANDLE_VALUE)return FALSE;
  if(ReadFile(file,receipt,64,&count,NULL)&&count==64)ok=TRUE;CloseHandle(file);
  for(i=0;i<64;i++)expected[i]=(char)b->key[i];expected[64]=0;
  if(!ok||memcmp(receipt,expected,64))return FALSE;
  return runtime_files_ready(b->root);
}
static BOOL copy_region(Bundle *b,HANDLE input,uint64_t offset,uint64_t bytes,const wchar_t *destination,const unsigned char expected[32]) {
  HANDLE output=INVALID_HANDLE_VALUE;BCRYPT_ALG_HANDLE algorithm=NULL;BCRYPT_HASH_HANDLE hash=NULL;
  unsigned char *buffer=NULL,digest[32];LARGE_INTEGER pos;BOOL ok=FALSE;DWORD count,written,part;
  pos.QuadPart=(LONGLONG)offset;if(!SetFilePointerEx(input,pos,NULL,FILE_BEGIN))return FALSE;
  output=CreateFileW(destination,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
  if(output==INVALID_HANDLE_VALUE)goto done;
  buffer=(unsigned char*)malloc(1024*1024);if(!buffer)goto done;
  if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,NULL,0)<0||BCryptCreateHash(algorithm,&hash,NULL,0,NULL,0,0)<0)goto done;
  while(bytes){if(InterlockedCompareExchange(&b->cancel,0,0)){SetLastError(ERROR_CANCELLED);goto done;}
    part=(DWORD)(bytes>1024*1024?1024*1024:bytes);
    if(!ReadFile(input,buffer,part,&count,NULL)||count!=part||BCryptHashData(hash,buffer,count,0)<0||!WriteFile(output,buffer,count,&written,NULL)||written!=count)goto done;
    bytes-=count;b->payloadRead+=count;
  }
  if(BCryptFinishHash(hash,digest,32,0)<0||memcmp(digest,expected,32)){SetLastError(ERROR_CRC);goto done;}
  ok=TRUE;
done:
  if(!ok)b->error=GetLastError()?GetLastError():ERROR_INVALID_DATA;
  if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);
  if(output!=INVALID_HANDLE_VALUE)CloseHandle(output);free(buffer);return ok;
}
// Let the verified extractor retain the same file lock if its parent dies.
// The explicit list excludes every other inheritable handle of the launcher.
static BOOL start_extractor(const wchar_t *extractor,wchar_t *command,const wchar_t *directory,HANDLE cacheLock,PROCESS_INFORMATION *process) {
  STARTUPINFOEXW start;SIZE_T size=0;HANDLE lockForChild=NULL;BOOL initialized=FALSE,ok=FALSE;DWORD error;
  ZeroMemory(&start,sizeof(start));start.StartupInfo.cb=sizeof(start);
  if(!DuplicateHandle(GetCurrentProcess(),cacheLock,GetCurrentProcess(),&lockForChild,0,TRUE,DUPLICATE_SAME_ACCESS))return FALSE;
  InitializeProcThreadAttributeList(NULL,1,0,&size);
  if(!size)goto done;
  start.lpAttributeList=malloc(size);if(!start.lpAttributeList){SetLastError(ERROR_OUTOFMEMORY);goto done;}
  if(!InitializeProcThreadAttributeList(start.lpAttributeList,1,0,&size))goto done;
  initialized=TRUE;
  if(!UpdateProcThreadAttribute(start.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,&lockForChild,sizeof(lockForChild),NULL,NULL))goto done;
  ok=CreateProcessW(extractor,command,NULL,NULL,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,directory,&start.StartupInfo,process);
done:
  error=GetLastError();
  if(initialized)DeleteProcThreadAttributeList(start.lpAttributeList);
  free(start.lpAttributeList);CloseHandle(lockForChild);if(!ok)SetLastError(error);
  return ok;
}
static BOOL extract(Bundle *b,const wchar_t *extractor,const wchar_t *archive,HANDLE cacheLock) {
  PROCESS_INFORMATION process;wchar_t *command=allocate_path();DWORD result=1,wait;BOOL ok=FALSE;
  if(!command){SetLastError(ERROR_OUTOFMEMORY);return FALSE;}
  if(swprintf_s(command,PATH_CHARS,L"\"%s\" x \"%s\" -o\"%s\" -y -bso0 -bsp0 -bse0",extractor,archive,b->stage)<0){free(command);return FALSE;}
  ZeroMemory(&process,sizeof(process));
  if(!start_extractor(extractor,command,b->stage,cacheLock,&process)){b->error=GetLastError();free(command);return FALSE;}free(command);
  do {
    wait=WaitForSingleObject(process.hProcess,100);
    if(InterlockedCompareExchange(&b->cancel,0,0)){
      TerminateProcess(process.hProcess,ERROR_CANCELLED);wait=WaitForSingleObject(process.hProcess,10000);break;
    }
  }while(wait==WAIT_TIMEOUT);
  b->extractorStillRunning=wait!=WAIT_OBJECT_0;
  if(wait==WAIT_OBJECT_0&&GetExitCodeProcess(process.hProcess,&result)&&result==0)ok=TRUE;
  if(!ok)b->error=InterlockedCompareExchange(&b->cancel,0,0)?ERROR_CANCELLED:ERROR_INVALID_DATA;
  CloseHandle(process.hThread);CloseHandle(process.hProcess);return ok;
}
static BOOL write_receipt(const wchar_t *directory,const wchar_t *key) {
  wchar_t *marker=joined(directory,L".wsmb-runtime-ready");char text[64];HANDLE file;DWORD count,error;BOOL ok;size_t i;
  if(!marker){SetLastError(ERROR_OUTOFMEMORY);return FALSE;}
  file=CreateFileW(marker,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
  if(file==INVALID_HANDLE_VALUE){error=GetLastError();free(marker);SetLastError(error);return FALSE;}
  free(marker);
  for(i=0;i<sizeof(text);i++)text[i]=(char)key[i];
  ok=WriteFile(file,text,sizeof(text),&count,NULL);
  if(ok&&count!=sizeof(text)){SetLastError(ERROR_WRITE_FAULT);ok=FALSE;}
  if(ok)ok=FlushFileBuffers(file);
  error=GetLastError();CloseHandle(file);if(!ok)SetLastError(error);
  return ok;
}
// Some managed volumes allow creating files but reject renaming directories.
// The caller owns a new destination and holds the digest mutex throughout.
static BOOL copy_runtime_tree(Bundle *b,const wchar_t *source,const wchar_t *destination,BOOL topLevel) {
  wchar_t *pattern=joined(source,L"*");WIN32_FIND_DATAW entry;HANDLE find;DWORD error=ERROR_SUCCESS;
  if(!pattern){SetLastError(ERROR_OUTOFMEMORY);return FALSE;}
  find=FindFirstFileW(pattern,&entry);free(pattern);
  if(find==INVALID_HANDLE_VALUE)return GetLastError()==ERROR_FILE_NOT_FOUND;
  do {
    wchar_t *from,*to;BOOL copied;
    if(InterlockedCompareExchange(&b->cancel,0,0)){error=ERROR_CANCELLED;break;}
    if(!wcscmp(entry.cFileName,L".")||!wcscmp(entry.cFileName,L".."))continue;
    if(topLevel&&!_wcsicmp(entry.cFileName,L".wsmb-runtime-ready"))continue;
    if(entry.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT){error=ERROR_INVALID_DATA;break;}
    from=joined(source,entry.cFileName);to=joined(destination,entry.cFileName);
    if(!from||!to){free(from);free(to);error=ERROR_OUTOFMEMORY;break;}
    if(entry.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){
      copied=CreateDirectoryW(to,NULL)&&copy_runtime_tree(b,from,to,FALSE);
    }else{
      // Win32's optional cancellation pointer is a 32-bit BOOL, like LONG.
      copied=CopyFileExW(from,to,NULL,NULL,(LPBOOL)&b->cancel,COPY_FILE_FAIL_IF_EXISTS);
    }
    if(!copied)error=InterlockedCompareExchange(&b->cancel,0,0)?ERROR_CANCELLED:GetLastError();
    free(from);free(to);
    if(!copied)break;
  }while(FindNextFileW(find,&entry));
  if(!error){error=GetLastError();if(error==ERROR_NO_MORE_FILES)error=ERROR_SUCCESS;}
  FindClose(find);SetLastError(error);return error==ERROR_SUCCESS;
}
static BOOL publish_by_copy(Bundle *b) {
  wchar_t *source,*destination;BOOL ok=FALSE;DWORD error;
  if(!CreateDirectoryW(b->root,NULL))return FALSE;
  source=filesystem_path(b->stage);destination=filesystem_path(b->root);
  if(!source||!destination){error=ERROR_OUTOFMEMORY;}
  else if(!copy_runtime_tree(b,source,destination,TRUE)){error=GetLastError();}
  else if(!runtime_files_ready(destination)){error=ERROR_INVALID_DATA;}
  else if(InterlockedCompareExchange(&b->cancel,0,0)){error=ERROR_CANCELLED;}
  else{ok=write_receipt(destination,b->key);error=GetLastError();}
  free(source);free(destination);
  if(!ok){remove_tree(b->root);SetLastError(error);}
  return ok;
}
// LocalAppData is shared by every logon session of this user. A zero-byte
// file beside the digest directory survives cache repair; only its open
// handle owns the lock. Windows releases it even if the launcher crashes.
static HANDLE lock_runtime(Bundle *b) {
  wchar_t name[84],*path;HANDLE handle=INVALID_HANDLE_VALUE;DWORD error=ERROR_SUCCESS;
  BY_HANDLE_FILE_INFORMATION info;ULONGLONG started=GetTickCount64();
  swprintf_s(name,84,L".wsmb-%s.lock",b->key);
  path=joined(b->base,name);if(!path){SetLastError(ERROR_OUTOFMEMORY);return INVALID_HANDLE_VALUE;}
  for(;;){
    if(InterlockedCompareExchange(&b->cancel,0,0)){error=ERROR_CANCELLED;break;}
    handle=CreateFileW(path,GENERIC_READ,0,NULL,OPEN_ALWAYS,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
    if(handle!=INVALID_HANDLE_VALUE){
      if(!GetFileInformationByHandle(handle,&info)){error=GetLastError();}
      else if(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)){error=ERROR_INVALID_DATA;}
      else break;
      CloseHandle(handle);handle=INVALID_HANDLE_VALUE;break;
    }
    error=GetLastError();
    if(error!=ERROR_SHARING_VIOLATION&&error!=ERROR_LOCK_VIOLATION)break;
    if(GetTickCount64()-started>=30ULL*60*1000){error=ERROR_TIMEOUT;break;}
    Sleep(100);
  }
  free(path);if(handle==INVALID_HANDLE_VALUE)SetLastError(error);return handle;
}
static DWORD WINAPI prepare(void *argument) {
  Bundle *b=(Bundle*)argument;HANDLE mutex=NULL,cacheLock=INVALID_HANDLE_VALUE,input=INVALID_HANDLE_VALUE;wchar_t mutexName[100],stageName[100];
  wchar_t *extractor=NULL,*archive=NULL;BOOL ok=FALSE,createdStage=FALSE;DWORD start=GetTickCount(),wait,attempt;
  swprintf_s(mutexName,100,L"Local\\WSMB-%s",b->key);mutex=CreateMutexW(NULL,FALSE,mutexName);
  if(!mutex)goto done;
  do {wait=WaitForSingleObject(mutex,100);if(InterlockedCompareExchange(&b->cancel,0,0)){b->error=ERROR_CANCELLED;goto done;}}while(wait==WAIT_TIMEOUT);
  if(wait!=WAIT_OBJECT_0&&wait!=WAIT_ABANDONED)goto done;
  cacheLock=lock_runtime(b);if(cacheLock==INVALID_HANDLE_VALUE)goto done;
  swprintf_s(stageName,100,L".preparing-%s",b->key);b->stage=joined(b->base,stageName);
  if(!b->stage){b->error=ERROR_OUTOFMEMORY;goto done;}
  // All writers, including an extractor whose parent terminated, have now
  // released this digest's lock. Only its private staging area is reclaimed.
  if(ready(b)){b->cacheHit=TRUE;remove_tree(b->stage);ok=TRUE;goto done;}
  if(!remove_tree(b->stage))goto done;
  if(GetFileAttributesW(b->root)!=INVALID_FILE_ATTRIBUTES){
    for(attempt=0;attempt<25;attempt++){if(remove_tree(b->root))break;Sleep(100);}
    if(attempt==25)goto done;
  }
  if(!CreateDirectoryW(b->stage,NULL))goto done;
  createdStage=TRUE;
  extractor=joined(b->stage,L".wsmb-7za.exe");archive=joined(b->stage,L".wsmb-payload.7z");
  if(!extractor||!archive)goto done;
  input=open_bundle(b->self,TRUE);
  if(input==INVALID_HANDLE_VALUE||!copy_region(b,input,b->stubBytes,b->extractorBytes,extractor,b->footer+48)||!copy_region(b,input,b->stubBytes+b->extractorBytes,b->archiveBytes,archive,b->footer+80)||!extract(b,extractor,archive,cacheLock))goto done;
  CloseHandle(input);input=INVALID_HANDLE_VALUE;
  if(!DeleteFileW(extractor)||!DeleteFileW(archive))goto done;
  if(InterlockedCompareExchange(&b->cancel,0,0)){b->error=ERROR_CANCELLED;goto done;}
  if(!runtime_files_ready(b->stage)){b->error=ERROR_INVALID_DATA;goto done;}
  if(!write_receipt(b->stage,b->key))goto done;
  if(!MoveFileExW(b->stage,b->root,MOVEFILE_WRITE_THROUGH)){
    DWORD moveError=GetLastError();
    if(!ready(b)){
      if(moveError!=ERROR_ACCESS_DENIED){b->error=moveError;goto done;}
      if(!publish_by_copy(b)){b->error=GetLastError();goto done;}
    }
  }
  ok=ready(b);
done:
  if(!ok&&!b->error)b->error=GetLastError()?GetLastError():ERROR_INVALID_DATA;
  if(input!=INVALID_HANDLE_VALUE)CloseHandle(input);
  if(createdStage&&!b->extractorStillRunning)remove_tree(b->stage);
  free(extractor);free(archive);
  if(cacheLock!=INVALID_HANDLE_VALUE)CloseHandle(cacheLock);
  if(mutex){ReleaseMutex(mutex);CloseHandle(mutex);}
  b->prepareMs=GetTickCount()-start;return ok?0:1;
}
static LRESULT CALLBACK window_proc(HWND window,UINT message,WPARAM wParam,LPARAM lParam) {
  if(message==WM_CLOSE){Bundle *b=(Bundle*)GetWindowLongPtrW(window,GWLP_USERDATA);if(b)InterlockedExchange(&b->cancel,1);return 0;}
  return DefWindowProcW(window,message,wParam,lParam);
}
static HWND progress_window(HINSTANCE instance,Bundle *b) {
  WNDCLASSW wc;INITCOMMONCONTROLSEX common;HWND window,bar,label;BOOL pt=(PRIMARYLANGID(GetUserDefaultUILanguage())==LANG_PORTUGUESE);
  ZeroMemory(&wc,sizeof(wc));wc.lpfnWndProc=window_proc;wc.hInstance=instance;wc.hCursor=LoadCursorW(NULL,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);wc.lpszClassName=L"WSMBPreparation";
  wc.hIcon=LoadIconW(instance,MAKEINTRESOURCEW(1));if(!wc.hIcon)wc.hIcon=LoadIconW(NULL,IDI_APPLICATION);RegisterClassW(&wc);
  common.dwSize=sizeof(common);common.dwICC=ICC_PROGRESS_CLASS;InitCommonControlsEx(&common);
  window=CreateWindowExW(WS_EX_APPWINDOW,wc.lpszClassName,pt?L"A preparar a aplicação":L"Preparing application",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU,CW_USEDEFAULT,CW_USEDEFAULT,450,150,NULL,NULL,instance,NULL);
  if(!window)return NULL;SetWindowLongPtrW(window,GWLP_USERDATA,(LONG_PTR)b);
  label=CreateWindowW(L"STATIC",pt?L"A primeira abertura requer preparação.\nAs próximas aberturas serão diretas.":L"The first launch requires preparation.\nSubsequent launches open directly.",WS_CHILD|WS_VISIBLE,20,15,410,45,window,NULL,instance,NULL);
  SendMessageW(label,WM_SETFONT,(WPARAM)GetStockObject(DEFAULT_GUI_FONT),TRUE);
  bar=CreateWindowExW(0,PROGRESS_CLASSW,NULL,WS_CHILD|WS_VISIBLE|PBS_MARQUEE,20,70,400,16,window,NULL,instance,NULL);SendMessageW(bar,PBM_SETMARQUEE,TRUE,30);
  ShowWindow(window,SW_SHOWNORMAL);UpdateWindow(window);return window;
}
static BOOL set_base(Bundle *b) {
  PWSTR local=NULL;wchar_t *parent;BOOL ok=FALSE;
  if(FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData,KF_FLAG_CREATE,NULL,&local)))return FALSE;
  parent=joined(local,L"WSMB");CoTaskMemFree(local);if(!parent)return FALSE;
  if(make_directory(parent)){b->base=joined(parent,L"runtimes");if(b->base&&make_directory(b->base))ok=TRUE;}
  free(parent);if(!ok)return FALSE;b->root=joined(b->base,b->key);return b->root!=NULL;
}
static void write_report(Bundle *b) {
  wchar_t *target=allocate_path();char json[320];HANDLE file;DWORD count;int size;
  if(!target)return;
  if(GetEnvironmentVariableW(L"WSMB_BOOT_REPORT",target,PATH_CHARS)>0){
    size=sprintf_s(json,sizeof(json),"{\"cacheHit\":%s,\"payloadBytesRead\":%llu,\"archiveExtractions\":%d,\"prepareMs\":%lu,\"errorCode\":%lu}\n",b->cacheHit?"true":"false",(unsigned long long)b->payloadRead,b->cacheHit?0:1,b->prepareMs,b->error);
    file=CreateFileW(target,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);
    if(file!=INVALID_HANDLE_VALUE){if(size>0)WriteFile(file,json,(DWORD)size,&count,NULL);CloseHandle(file);}
  }free(target);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,PWSTR arguments,int show) {
  Bundle b;HANDLE worker=NULL;HWND window=NULL;DWORD status=1,wait;MSG message;STARTUPINFOW start;PROCESS_INFORMATION child;wchar_t *executable=NULL,*command=NULL,errorText[256];
  UNREFERENCED_PARAMETER(previous);UNREFERENCED_PARAMETER(arguments);UNREFERENCED_PARAMETER(show);
  ZeroMemory(&b,sizeof(b));b.self=allocate_path();
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32|LOAD_LIBRARY_SEARCH_APPLICATION_DIR);
  if(!b.self||!GetModuleFileNameW(NULL,b.self,PATH_CHARS)||!read_footer(&b)||!set_base(&b)){b.error=GetLastError()?GetLastError():ERROR_INVALID_DATA;goto done;}
  // Do not create even a splash window for a prepared application.
  if(!ready(&b))window=progress_window(instance,&b);
  worker=CreateThread(NULL,0,prepare,&b,0,NULL);if(!worker){b.error=GetLastError();goto done;}
  do {
    wait=MsgWaitForMultipleObjects(1,&worker,FALSE,INFINITE,QS_ALLINPUT);
    if(wait==WAIT_OBJECT_0+1)while(PeekMessageW(&message,NULL,0,0,PM_REMOVE)){TranslateMessage(&message);DispatchMessageW(&message);}
  }while(wait==WAIT_OBJECT_0+1);
  if(wait!=WAIT_OBJECT_0||!GetExitCodeThread(worker,&status)||status!=0)goto done;
  if(InterlockedCompareExchange(&b.cancel,0,0)){b.error=ERROR_CANCELLED;goto done;}
  if(window){DestroyWindow(window);window=NULL;}
  write_report(&b);
  executable=joined(b.root,L"LaunchBox Viewer.exe");command=allocate_path();if(!executable||!command){b.error=ERROR_OUTOFMEMORY;goto done;}
  if(swprintf_s(command,PATH_CHARS,L"\"%s\" --wsmb-cached --wsmb-launcher=\"%s\"",executable,b.self)<0){b.error=ERROR_FILENAME_EXCED_RANGE;goto done;}
  ZeroMemory(&start,sizeof(start));start.cb=sizeof(start);ZeroMemory(&child,sizeof(child));
  if(!CreateProcessW(executable,command,NULL,NULL,FALSE,0,NULL,b.root,&start,&child)){b.error=GetLastError();goto done;}
  CloseHandle(child.hThread);WaitForSingleObject(child.hProcess,INFINITE);GetExitCodeProcess(child.hProcess,&status);CloseHandle(child.hProcess);
done:
  if(worker)CloseHandle(worker);if(window)DestroyWindow(window);
  if(b.error&&b.error!=ERROR_CANCELLED){wchar_t quiet[2];write_report(&b);swprintf_s(errorText,256,L"Não foi possível preparar ou abrir a aplicação.\nErro Windows: %lu.\nVolte a tentar ou obtenha uma nova cópia do ficheiro.",b.error);if(!GetEnvironmentVariableW(L"WSMB_BOOT_QUIET",quiet,2))MessageBoxW(NULL,errorText,L"Windows & Mac Software Builder",MB_OK|MB_ICONERROR);status=1;}
  free(b.self);free(b.base);free(b.root);free(b.stage);free(executable);free(command);return (int)status;
}
