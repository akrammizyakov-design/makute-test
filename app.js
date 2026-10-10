(function(){
"use strict";
/* Документооборот «Менеджер ↔ Бухгалтерия» — ТЕСТОВАЯ версия на Firebase (Auth + Realtime Database) */
firebase.initializeApp(window.FIREBASE_CONFIG);
const auth=firebase.auth(), db=firebase.database();
const DOMAIN=window.LOGIN_DOMAIN||"docflow.test";
const MAX_FILE=5*1048576; // 5 МБ: файлы хранятся в базе (base64), для теста достаточно
const TS=firebase.database.ServerValue.TIMESTAMP;

const STATUS={
  sent_acc:{label:"Отправлена в бухгалтерию",turn:"acc"},
  work:{label:"В работе",turn:"acc"},
  clar:{label:"На уточнении",turn:"mgr"},
  sent_mgr:{label:"Отправлена менеджеру",turn:"mgr"},
  done:{label:"Исполнено",turn:null},
  cancelled:{label:"Отменена",turn:null}
};
const ROLE={mgr:"Менеджер",acc:"Бухгалтер",head:"Руководитель"};
const TABS=["sent_acc","work","clar","sent_mgr","done","cancelled"];
const STUCK_DAYS=2, D=864e5, H=36e5;
const ACTIONS={
  mgr:[
    {id:"withdraw",label:"Отозвать",kind:"sec",from:["sent_acc"],to:"cancelled",cmt:"opt"},
    {id:"answer",label:"Ответить и вернуть",kind:"pri",from:["clar"],to:"answer",cmt:"req",file:"opt"},
    {id:"remark",label:"Есть замечание",kind:"sec",from:["sent_mgr"],to:"work",cmt:"req"},
    {id:"done",label:"Исполнено",kind:"ok",from:["sent_mgr"],to:"done",cmt:"opt"},
    {id:"reopen",label:"Переоткрыть",kind:"sec",from:["done"],to:"work",cmt:"req"},
    {id:"cancel",label:"Отменить заявку",kind:"ghost",from:["work","clar","sent_mgr"],to:"cancelled",cmt:"req"}],
  acc:[
    {id:"return",label:"Вернуть на доработку",kind:"sec",from:["sent_acc","work"],to:"clar",cmt:"req"},
    {id:"take",label:"Взять в работу",kind:"pri",from:["sent_acc"],to:"work",cmt:"opt"},
    {id:"send",label:"Отправить менеджеру",kind:"pri",from:["work"],to:"sent_mgr",cmt:"opt",file:"opt"},
    {id:"forceDone",label:"Закрыть за менеджера",kind:"ghost",from:["sent_mgr"],to:"done",cmt:"req"},
    {id:"reopen",label:"Переоткрыть",kind:"sec",from:["done"],to:"work",cmt:"req"},
    {id:"cancel",label:"Отменить заявку",kind:"ghost",from:["sent_acc","work","clar"],to:"cancelled",cmt:"req"}]
};
const HINT={take:"Заявка закрепится за вами, менеджер получит уведомление.",return:"Напишите, чего не хватает. Заявка вернётся менеджеру.",send:"Заявка уйдёт менеджеру. При необходимости приложите документ.",done:"Заявка закроется и уйдёт в архив. Её можно будет переоткрыть.",remark:"Опишите ошибку. Заявка вернётся бухгалтеру.",answer:"Ответьте на вопрос бухгалтера. Заявка вернётся в работу.",withdraw:"Бухгалтер ещё не взял заявку. Она будет отменена.",cancel:"Заявка будет отменена. Вторая сторона получит уведомление.",reopen:"Заявка вернётся в работу к бухгалтеру.",forceDone:"Используйте, если менеджер не может подтвердить сам (например, уволился)."};

const st={view:"list",sel:null,tab:"sent_acc",mgrF:null,authMode:"login",q:"",detail:false,modal:null,draft:"",pend:null,toast:null,users:[],reqs:[],msgs:[],me:null,uid:null,ready:false,busy:false,login:{}};
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const me=()=>st.me;
const user=id=>st.users.find(u=>u.id===id)||{name:"—",role:"mgr"};
const T=s=>typeof s==="number"?s:(s?new Date(s).getTime():0);
const kb=b=>b<1048576?Math.max(1,Math.round(b/1024))+" КБ":(b/1048576).toFixed(1)+" МБ";
const ERR={"auth/invalid-credential":"Неверный логин или пароль","auth/wrong-password":"Неверный логин или пароль","auth/user-not-found":"Неверный логин или пароль","auth/invalid-email":"Логин: латинские буквы, цифры, точка, дефис","auth/email-already-in-use":"Такой логин уже есть","auth/weak-password":"Пароль слишком простой (минимум 8 символов)","auth/too-many-requests":"Слишком много попыток. Подождите пару минут","auth/requires-recent-login":"Выйдите и войдите заново, затем повторите","PERMISSION_DENIED":"Нет прав на это действие"};
const errText=e=>ERR[e&&e.code]||(e&&String(e.message||"").includes("PERMISSION_DENIED")?ERR.PERMISSION_DENIED:(e&&e.message)||"Ошибка");
function when(ts){
  const t=T(ts), d=Date.now()-t, dt=new Date(t);
  const hm=dt.toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});
  if(d<60e3) return "только что";
  if(d<H) return Math.round(d/60e3)+" мин назад";
  if(dt.toDateString()===new Date().toDateString()) return "сегодня "+hm;
  if(dt.toDateString()===new Date(Date.now()-D).toDateString()) return "вчера "+hm;
  return dt.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})+" "+hm;
}
const daysSince=t=>Math.floor((Date.now()-T(t))/D);
const I={search:'<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',plus:'<path d="M12 5v14M5 12h14"/>',back:'<path d="M15 5l-7 7 7 7"/>',clip:'<path d="M21 11.5l-8.6 8.6a5.2 5.2 0 01-7.4-7.4l9-9a3.5 3.5 0 015 5l-8.9 8.9a1.8 1.8 0 01-2.6-2.6l8.2-8.2"/>',send:'<path d="M4 12l16-8-6 16-2.5-6.5z"/>',file:'<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',list:'<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',chart:'<path d="M4 20V11M10 20V5M16 20v-6M3 20h18"/>',users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.5-5 6.5-5s5.7 1.5 6.5 5"/><path d="M16 4.6a3.5 3.5 0 010 6.8M18 15c2 .6 3.3 2.3 3.8 5"/>',bell:'<path d="M6 16v-5a6 6 0 0112 0v5l2 2H4z"/><path d="M10 21h4"/>',out:'<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h11"/>'};
const ic=n=>`<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[n]}</svg>`;
const stp=s=>`<span class="st st-${s}">${STATUS[s]?STATUS[s].label:esc(s)}</span>`;
const genPw=()=>{const a="abcdefghjkmnpqrstuvwxyz23456789";let s="";for(const x of crypto.getRandomValues(new Uint32Array(10)))s+=a[x%a.length];return s;};
const list=snap=>{const v=snap.val()||{};return Object.keys(v).map(k=>Object.assign({id:k},v[k]));};

/* ---------- «прочитано» хранится на устройстве ---------- */
const seenKey=()=>"docflow-seen-"+(st.uid||"");
function getSeen(){try{return JSON.parse(localStorage.getItem(seenKey())||"{}");}catch(e){return {};}}
function markSeen(r){try{const s=getSeen();s[r.id]=Date.now();localStorage.setItem(seenKey(),JSON.stringify(s));}catch(e){}}
function unread(r){if(!r.last_msg||r.last_msg_by===st.uid)return false;return T(r.last_msg)>(getSeen()[r.id]||0);}

function myTurn(r){return STATUS[r.status]&&STATUS[r.status].turn===me().role;}
function turnText(r){const t=STATUS[r.status]&&STATUS[r.status].turn;if(!t)return "";if(t===me().role)return "Ждёт вашего действия";return t==="acc"?"Ждём бухгалтерию":"Ждём менеджера";}
const isStuck=r=>STATUS[r.status]&&STATUS[r.status].turn&&daysSince(r.last_change||r.created)>=STUCK_DAYS;
function actionsFor(r){
  const u=me(); if(!u||u.role==="head") return [];
  if(u.role==="mgr"&&r.mgr!==st.uid) return [];
  return (ACTIONS[u.role]||[]).filter(a=>a.from.includes(r.status));
}
function filtered(){
  let L=st.reqs.filter(r=>r.status===st.tab);
  if(st.mgrF) L=L.filter(r=>r.mgr===st.mgrF);
  if(st.q.trim()){const q=st.q.trim().toLowerCase();L=L.filter(r=>(r.no+" "+(r.kind||"")+" "+(r.real||"")+" "+r.client+" "+user(r.mgr).name).toLowerCase().includes(q));}
  return L.sort((a,b)=>T(b.last_msg||b.created)-T(a.last_msg||a.created));
}
const kindText=r=>r.kind?r.kind:(r.real?"Реализация № "+r.real:"—");

/* ---------- данные и подписки (Realtime Database) ---------- */
let offs=[];
function unsubscribeAll(){offs.forEach(f=>{try{f();}catch(e){}});offs=[];}
function watch(ref,cb){const h=ref.on("value",cb,e=>toast(errText(e)));offs.push(()=>ref.off("value",h));}
let msgRef=null,msgH=null;
function watchMsgs(id){
  if(msgRef)msgRef.off("value",msgH);
  msgRef=db.ref("messages/"+id);
  msgH=msgRef.orderByChild("created").on("value",s=>{st.msgs=list(s).sort((a,b)=>T(a.created)-T(b.created));if(st.sel===id){markSeenIfOpen();render();}},e=>toast(errText(e)));
}
function startData(){
  unsubscribeAll();
  watch(db.ref("users"),s=>{st.users=list(s).sort((a,b)=>String(a.name).localeCompare(b.name,"ru"));const m=st.users.find(u=>u.id===st.uid);if(m){st.me=m;if(!m.active){toast("Учётная запись заблокирована");logout();return;}}render();});
  const q=me().role==="mgr"?db.ref("requests").orderByChild("mgr").equalTo(st.uid):db.ref("requests");
  let first=true;
  watch(q,s=>{
    const prev=st.reqs; st.reqs=list(s);
    if(!first) st.reqs.forEach(r=>{const p=prev.find(x=>x.id===r.id);if(r.last_msg_by&&r.last_msg_by!==st.uid&&(!p||p.last_msg!==r.last_msg))notify(r,p);});
    first=false; st.ready=true;
    if(st.sel)markSeenIfOpen();
    if(!st.sel&&window.matchMedia("(min-width: 861px)").matches&&me().role!=="head"){const f=filtered();if(f.length){openReq(f[0].id);return;}}
    render();
  });
}
function markSeenIfOpen(){const r=st.reqs.find(x=>x.id===st.sel);if(r&&!document.hidden&&(st.detail||window.matchMedia("(min-width: 861px)").matches))markSeen(r);}
async function notify(r,prev){
  const title="Заявка #"+r.no;
  const body=prev&&prev.status!==r.status?"Статус: "+STATUS[r.status].label:"Новое сообщение от "+user(r.last_msg_by).name;
  if(document.hidden&&"Notification" in window&&Notification.permission==="granted"){
    try{const reg=await navigator.serviceWorker.getRegistration();if(reg)reg.showNotification(title,{body,icon:"icon-192.png",tag:r.id});else new Notification(title,{body});}catch(e){}
  } else if(st.sel!==r.id) toast(title+": "+body);
}
function readFile(f){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result).split(",")[1]);fr.onerror=()=>rej(new Error("Не удалось прочитать файл"));fr.readAsDataURL(f);});}
async function saveFile(f,rid){
  const ref=db.ref("files").push();
  await ref.set({name:f.name,type:f.type||"application/octet-stream",size:f.size,data:await readFile(f),req:rid||"",by:st.uid,created:TS});
  return {id:ref.key,name:f.name,size:f.size};
}
// Файл загружается из базы, затем показывается окно с кнопками «Скачать / Открыть / Поделиться».
// Ссылки нажимает сам пользователь — так скачивание работает и на телефоне, и в установленном приложении.
async function openFile(meta){
  st.modal={type:"file",loading:true}; render();
  try{
    const s=await db.ref("files/"+meta.id).once("value"); const v=s.val(); if(!v) throw new Error("Файл не найден");
    const bin=atob(v.data), arr=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
    const type=v.type||"application/octet-stream";
    const blob=new Blob([arr],{type});
    if(st.fileUrl) URL.revokeObjectURL(st.fileUrl);
    st.fileUrl=URL.createObjectURL(blob);
    let fileObj=null; try{fileObj=new File([blob],v.name,{type});}catch(x){}
    const canShare=!!(fileObj&&navigator.canShare&&navigator.canShare({files:[fileObj]}));
    st.modal={type:"file",name:v.name,size:v.size||arr.length,url:st.fileUrl,fileObj,canShare};
  }catch(e){st.modal=null;toast("Не удалось загрузить файл: "+errText(e));}
  render();
}
async function addMsg(rid,data){
  const ref=db.ref("messages/"+rid).push();
  await ref.set(Object.assign({author:st.uid,text:"",sys:false,created:TS},data));
  return ref.key;
}
async function transition(r,a,comment,file){
  let to=a.to; if(to==="answer") to=r.acc?"work":"sent_acc";
  if(comment||file) await addMsg(r.id,{text:comment||"",file:file||null});
  const upd={status:to,last_change:TS,last_msg:TS,last_msg_by:st.uid};
  if(a.id==="take"||(me().role==="acc"&&to==="work"&&!r.acc)) upd.acc=st.uid;
  if(to==="clar") upd.returns=(r.returns||0)+1;
  await db.ref("requests/"+r.id).update(upd);
  await addMsg(r.id,{sys:true,status:to});
}

/* ---------- экраны входа ---------- */
function renderLogin(){
  const L=st.login;
  if(st.authMode==="forgot") return `<main class="auth"><form class="authbox" data-form="forgot">
    <div class="logo big">makute</div><h1>Восстановление пароля</h1>
    <p class="muted">Для руководителя: введите свою почту, мы пришлём ссылку для смены пароля. Менеджерам и бухгалтерам пароль сбрасывает руководитель.</p>
    ${L.sent?`<div class="okmsg">Если такая почта есть в системе, письмо уже отправлено. Проверьте входящие и папку «Спам».</div>`:`
    <div class="fld"><label for="fe">Почта</label><input id="fe" type="email" autocomplete="email" autocapitalize="off" value="${esc(L.u&&L.u.includes("@")?L.u:"")}" required></div>
    ${L.err?`<div class="err">${esc(L.err)}</div>`:""}
    <button class="btn pri" type="submit" ${st.busy?"disabled":""}>${st.busy?"Отправляем…":"Отправить ссылку"}</button>`}
    <button class="btn ghost" type="button" data-act="tologin">Вернуться ко входу</button></form></main>`;
  return `<main class="auth"><form class="authbox" data-form="login">
    <div class="logo big">makute</div><h1>Документооборот</h1><p class="muted">Тестовая версия · логин и пароль выдаёт руководитель</p>
    <div class="fld"><label for="lu">Логин (руководитель — почта)</label><input id="lu" type="text" autocomplete="username" autocapitalize="off" value="${esc(L.u||"")}" required></div>
    <div class="fld"><label for="lp">Пароль</label><input id="lp" type="password" autocomplete="current-password" required></div>
    ${L.err?`<div class="err">${esc(L.err)}</div>`:""}
    <button class="btn pri" type="submit" ${st.busy?"disabled":""}>${st.busy?"Входим…":"Войти"}</button>
    <button class="btn ghost" type="button" data-act="forgot">Забыли пароль?</button></form></main>`;
}
function renderChangePw(){
  const L=st.login;
  return `<main class="auth"><form class="authbox" data-form="chpw">
    <h1>Придумайте свой пароль</h1><p class="muted">Вы вошли с временным паролем от руководителя. Задайте свой — минимум 8 символов.</p>
    <div class="fld"><label for="p1">Новый пароль</label><input id="p1" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="fld"><label for="p2">Повторите пароль</label><input id="p2" type="password" autocomplete="new-password" minlength="8" required></div>
    ${L.err?`<div class="err">${esc(L.err)}</div>`:""}
    <button class="btn pri" type="submit" ${st.busy?"disabled":""}>Сохранить и войти</button>
    <button class="btn ghost" type="button" data-act="logout">Выйти</button></form></main>`;
}

/* ---------- основной интерфейс ---------- */
function render(){
  const root=$("#root");
  const ae=document.activeElement, aid=ae&&ae.id, sel=ae&&ae.selectionStart!=null?[ae.selectionStart,ae.selectionEnd]:null;
  if(!st.uid){root.innerHTML=renderLogin();return;}
  if(!st.me){root.innerHTML=`<div class="placeholder">Загрузка…</div>`;return;}
  if(st.me.must_change_pw){root.innerHTML=renderChangePw();return;}
  if(!st.ready){root.innerHTML=`<div class="placeholder">Загрузка…</div>`;return;}
  const u=me();
  const views=u.role==="head"?[["dash","Дашборд","chart"],["list","Заявки","list"],["users","Сотрудники","users"]]:[["list","Заявки","list"]];
  if(!views.find(v=>v[0]===st.view)) st.view=views[0][0];
  const turnCount=st.reqs.filter(myTurn).length;
  const canNotify="Notification" in window&&Notification.permission==="default";
  const top=`<div class="demo"><b>Документооборот · тест</b><span class="sp"></span>${canNotify?`<button data-act="notif">${ic("bell")} Включить уведомления</button>`:""}<span class="who">${esc(u.name)} · ${ROLE[u.role].toLowerCase()}</span><button data-act="logout" aria-label="Выйти">${ic("out")}</button></div>`;
  const side=`<nav class="side" aria-label="Разделы"><div class="brand"><div class="logo">makute</div><div><span>Документооборот</span></div></div>
    ${views.map(v=>`<button class="nav ${st.view===v[0]?"on":""}" data-act="view" data-v="${v[0]}">${ic(v[2])}<span>${v[1]}</span>${v[0]==="list"&&turnCount?`<span class="cnt">${turnCount}</span>`:""}</button>`).join("")}
    <div class="me"><b>${esc(u.name)}</b>${ROLE[u.role]}</div></nav>`;
  const main=st.view==="dash"?renderDash():st.view==="users"?renderUsers():renderList()+renderDetail();
  const tabs=views.length>1?`<nav class="tabbar" aria-label="Разделы">${views.map(v=>`<button class="${st.view===v[0]?"on":""}" data-act="view" data-v="${v[0]}">${ic(v[2])}<span>${v[1]}</span></button>`).join("")}</nav>`:"";
  root.innerHTML=top+`<div class="app ${st.detail&&st.view==="list"?"showdetail":""}">${side}${main}</div>`+tabs+renderModal()+(st.toast?`<div class="toast" role="status">${esc(st.toast)}</div>`:"");
  const ch=$(".chat"); if(ch) ch.scrollTop=ch.scrollHeight;
  const ta=$("#draft"); if(ta) ta.value=st.draft;
  if(aid){const el=document.getElementById(aid);if(el){el.focus();if(sel&&el.setSelectionRange)try{el.setSelectionRange(sel[0],sel[1]);}catch(e){}}}
  if(st.focus){const el=$(st.focus);if(el)el.focus();st.focus=null;}
}

function renderList(){
  const u=me(), L=filtered();
  const cnt=t=>st.reqs.filter(r=>r.status===t&&(!st.mgrF||r.mgr===st.mgrF)).length;
  const extra=st.mgrF?`<button class="chip on" data-act="mgrclear">${esc(user(st.mgrF).name)} ✕</button>`:"";
  const items=L.length?L.map(r=>`<button class="item ${st.sel===r.id?"on":""}" data-act="open" data-id="${r.id}">
    <div class="r1"><b>#${r.no}</b>${unread(r)?`<span class="unr">новое</span>`:""}<span class="when">${when(r.last_msg||r.created)}</span></div>
    <div class="r2">${esc(kindText(r))} · ${esc(r.client)}${u.role!=="mgr"?"<br>"+esc(user(r.mgr).name):""}</div>
    <div class="r3">${stp(r.status)}${r.returns?`<span class="ret">возвратов: ${r.returns}</span>`:""}<span class="turn ${myTurn(r)?"myturn":""}">${turnText(r)}</span></div></button>`).join("")
    :`<div class="empty">${st.q?"Ничего не найдено. Проверьте номер заявки, вид запроса или клиента.":"В этой вкладке заявок нет."}</div>`;
  return `<section class="listcol"><div class="lhead"><h1>Заявки</h1></div>
    <label class="search">${ic("search")}<input id="q" type="text" placeholder="№ заявки, вид запроса, клиент${u.role!=="mgr"?", менеджер":""}" value="${esc(st.q)}" data-on="q" aria-label="Поиск"></label>
    <div class="chips" role="tablist">${extra}${TABS.map(t=>`<button class="chip ${st.tab===t?"on":""}" role="tab" aria-selected="${st.tab===t}" data-act="tab" data-t="${t}">${STATUS[t].label} · ${cnt(t)}</button>`).join("")}</div>
    <div class="listwrap"><div class="items">${items}</div>
    ${u.role==="mgr"?`<button class="fab" data-act="new">${ic("plus")}Новая заявка</button>`:""}</div></section>`;
}

function renderDetail(){
  const r=st.reqs.find(x=>x.id===st.sel);
  if(!r) return `<div class="placeholder">Выберите заявку в списке</div>`;
  const u=me();
  const fileBtn=f=>f&&f.id?`<button class="file" data-act="file" data-fid="${esc(f.id)}">${ic("file")}<span>${esc(f.name)}</span><small>${kb(f.size||0)}</small></button>`:"";
  const first=`<div class="msg ${r.mgr===st.uid?"mine":""}"><div class="mh"><b>${esc(user(r.mgr).name)}</b> менеджер · ${when(r.created)} · создал заявку</div>
    <div class="bub">${r.comment?esc(r.comment):""}${fileBtn(r.invoice)}</div></div>`;
  const msgs=st.msgs.map(m=>{
    if(m.sys) return `<div class="sys">Статус: <b>${STATUS[m.status]?STATUS[m.status].label:esc(m.status)}</b>${m.author?" · "+esc(user(m.author).name):""} · ${when(m.created)}</div>`;
    const a=user(m.author), mine=m.author===st.uid;
    return `<div class="msg ${mine?"mine":""}"><div class="mh"><b>${esc(a.name)}</b> ${ROLE[a.role]?ROLE[a.role].toLowerCase():""} · ${when(m.created)}</div>
      <div class="bub">${m.text?esc(m.text):""}${fileBtn(m.file)}</div></div>`;
  }).join("");
  const A=actionsFor(r);
  let bottom="";
  if(u.role==="head") bottom=`<div class="readonly">Руководитель видит всю переписку и историю, но не меняет статусы</div>`;
  else{
    if(A.length) bottom+=`<div class="acts">${A.map(a=>`<button class="btn ${a.kind}" data-act="act" data-a="${a.id}">${a.label}</button>`).join("")}</div>`;
    bottom+=(st.pend?`<div class="pend">${ic("file")}${esc(st.pend.name)} · ${kb(st.pend.size)}<button data-act="unpend">убрать</button></div>`:"")+
      `<div class="composer"><label class="icb" title="Прикрепить файл">${ic("clip")}<input type="file" hidden data-on="chatfile" aria-label="Прикрепить файл"></label>
       <textarea id="draft" rows="1" placeholder="Сообщение… статус от этого не меняется" data-on="draft" aria-label="Сообщение"></textarea>
       <button class="icb send" data-act="sendmsg" aria-label="Отправить" ${st.busy?"disabled":""}>${ic("send")}</button></div>`;
  }
  return `<section class="detail"><div class="dhead"><button class="back" data-act="back" aria-label="Назад к списку">${ic("back")}</button>
    <div class="dt"><h2>Заявка #${r.no}</h2><div class="meta">${esc(kindText(r))} · ${esc(r.client)}<br>Менеджер: ${esc(user(r.mgr).name)}${r.acc?" · Бухгалтер: "+esc(user(r.acc).name):""}</div>
    <div class="strow">${stp(r.status)}${r.returns?`<span class="ret">возвратов на уточнение: ${r.returns}</span>`:""}<span class="turn ${myTurn(r)?"myturn":""}">${turnText(r)}</span></div></div></div>
    <div class="chat">${first}${msgs}</div>${bottom}</section>`;
}

function renderDash(){
  const R=st.reqs, open=R.filter(r=>!["done","cancelled"].includes(r.status));
  const kp=s=>`<button class="kpi" data-act="goto" data-f="s:${s}"><span class="n">${R.filter(r=>r.status===s).length}</span>${stp(s)}</button>`;
  const stuck=open.filter(isStuck).sort((a,b)=>T(a.last_change)-T(b.last_change));
  const mg=st.users.filter(x=>x.role==="mgr").map(m=>{const mine=R.filter(r=>r.mgr===m.id);return {m,open:mine.filter(r=>!["done","cancelled"].includes(r.status)).length,done:mine.filter(r=>r.status==="done").length,ret:mine.reduce((s,r)=>s+(r.returns||0),0)};}).sort((a,b)=>b.ret-a.ret);
  const many=R.filter(r=>(r.returns||0)>=2);
  return `<main class="page"><h1>Дашборд</h1><div class="subt">Все заявки компании. Нажмите на цифру или строку, чтобы открыть список.</div>
  <div class="kpis">${["sent_acc","work","clar","sent_mgr","done"].map(kp).join("")}</div>
  <div class="grid2">
   <div class="box"><h3>Зависли дольше ${STUCK_DAYS} дней</h3>${stuck.length?`<table><tr><th>Заявка</th><th>Менеджер</th><th>Статус</th><th>Дней</th></tr>
    ${stuck.map(r=>`<tr class="click" data-act="openfrom" data-id="${r.id}"><td>#${r.no}</td><td>${esc(user(r.mgr).name)}</td><td>${stp(r.status)}</td><td class="red">${daysSince(r.last_change)}</td></tr>`).join("")}</table>`:`<p class="muted">Зависших заявок нет</p>`}</div>
   <div class="box"><h3>По менеджерам</h3>${mg.length?`<table><tr><th>Менеджер</th><th>Открыто</th><th>Исполнено</th><th>Возвратов</th></tr>
    ${mg.map(x=>`<tr class="click" data-act="goto" data-f="m:${x.m.id}"><td>${esc(x.m.name)}</td><td>${x.open}</td><td>${x.done}</td><td class="${x.ret>=2?"red":""}">${x.ret}</td></tr>`).join("")}</table>`:`<p class="muted">Менеджеров пока нет. Добавьте их в разделе «Сотрудники».</p>`}</div>
   <div class="box"><h3>Много возвратов на уточнение</h3>${many.length?`<table><tr><th>Заявка</th><th>Менеджер</th><th>Возвратов</th><th>Статус</th></tr>
    ${many.map(r=>`<tr class="click" data-act="openfrom" data-id="${r.id}"><td>#${r.no}</td><td>${esc(user(r.mgr).name)}</td><td class="red">${r.returns}</td><td>${stp(r.status)}</td></tr>`).join("")}</table>`:`<p class="muted">Заявок с 2 и более возвратами нет</p>`}</div>
  </div></main>`;
}

function renderUsers(){
  return `<main class="page"><div class="phead"><div><h1>Сотрудники</h1><div class="subt">Логины и временные пароли выдаёт руководитель</div></div><button class="btn pri" data-act="adduser">Добавить сотрудника</button></div>
  <div class="box"><table><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Статус</th><th></th></tr>
  ${st.users.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>${esc(x.username)}</td><td><span class="role role-${x.role}">${ROLE[x.role]||"—"}</span></td><td class="${x.active?"":"muted"}">${x.active?(x.must_change_pw?"Ещё не входил":"Активен"):"Заблокирован"}</td>
   <td style="white-space:nowrap">${x.id===st.uid?`<span class="muted">это вы</span>`:`<button class="linkb" data-act="block" data-id="${x.id}">${x.active?"Заблокировать":"Разблокировать"}</button>`}</td></tr>`).join("")}
  </table></div><p class="muted" style="margin-top:12px;font-size:13px">В тестовой версии кнопки «Сбросить пароль» нет: если менеджер или бухгалтер забыл пароль, заблокируйте его и создайте новый логин. Руководитель восстанавливает свой пароль сам — по ссылке «Забыли пароль?» на экране входа. В рабочей версии будет кнопка «Сбросить пароль».</p></main>`;
}

function renderModal(){
  const M=st.modal; if(!M) return "";
  let body="";
  const fileField=(label,req)=>`<div class="fld"><span class="flbl">${label}${req?" (обязательно)":" (необязательно)"} · до 5 МБ</span><label class="drop">${ic("file")}<span>${M.file?esc(M.file.name)+" · "+kb(M.file.size):"Выбрать файл"}</span><input type="file" data-on="mfile"></label></div>`;
  const btns=(label,kind,act)=>`<div class="mrow"><button class="btn sec" data-act="close" ${st.busy?"disabled":""}>Отмена</button><button class="btn ${kind}" data-act="${act}" ${st.busy?"disabled":""}>${st.busy?"Отправляем…":label}</button></div>`;
  if(M.type==="act"){
    const a=M.a;
    body=`<h3>${a.label}</h3><p>${HINT[a.id]||""}</p>
    <div class="fld"><label for="mc">Комментарий${a.cmt==="req"?" (обязательно)":" (необязательно)"}</label><textarea id="mc">${esc(M.c||"")}</textarea></div>
    ${a.file?fileField("Файл",a.file==="req"):""}${M.err?`<div class="err">${esc(M.err)}</div>`:""}${btns(a.label,a.kind==="ghost"?"sec":a.kind,"confirm")}`;
  }
  if(M.type==="new"){
    body=`<h3>Новая заявка</h3>
    <div class="fld"><label for="nk">Вид запроса</label><input id="nk" type="text" value="${esc(M.kind||"")}" placeholder="Например: выставить ЭСФ"></div>
    <div class="fld"><label for="ncl">Клиент</label><input id="ncl" type="text" value="${esc(M.client||"")}" placeholder="ТОО или ИП"></div>
    <div class="fld"><label for="mc">Комментарий</label><textarea id="mc" placeholder="Например: срочно, клиент ждёт до пятницы">${esc(M.c||"")}</textarea></div>
    ${fileField("Файл",false)}
    ${M.err?`<div class="err">${esc(M.err)}</div>`:""}${btns("Отправить в бухгалтерию","pri","create")}`;
  }
  if(M.type==="adduser"){
    body=`<h3>Новый сотрудник</h3>
    <div class="fld"><label for="un">ФИО</label><input id="un" type="text" value="${esc(M.name||"")}"></div>
    <div class="fld"><label for="ur">Роль</label><select id="ur" data-on="urole">${["mgr","acc","head"].map(r=>`<option value="${r}" ${M.role===r?"selected":""}>${ROLE[r]}</option>`).join("")}</select></div>
    ${M.role==="head"
      ?`<div class="fld"><label for="ul">Почта руководителя (для входа и восстановления пароля)</label><input id="ul" type="email" autocapitalize="off" value="${esc(M.login||"")}" placeholder="name@gmail.com"></div>`
      :`<div class="fld"><label for="ul">Логин (латиницей, например a.seitov)</label><input id="ul" type="text" autocapitalize="off" value="${esc(M.login||"")}"></div>`}
    <p>Временный пароль сгенерируется автоматически. Сотрудник сменит его при первом входе.</p>
    ${M.err?`<div class="err">${esc(M.err)}</div>`:""}${btns("Добавить","pri","saveuser")}`;
  }
  if(M.type==="file"){
    if(M.loading) body=`<h3>Загружаем файл…</h3><p>Секунду.</p>`;
    else body=`<h3>${esc(M.name)}</h3><p>${kb(M.size)}</p>
    <div class="filebtns">
      <a class="btn pri" href="${M.url}" download="${esc(M.name)}">Скачать</a>
      <a class="btn sec" href="${M.url}" target="_blank" rel="noopener">Открыть</a>
      ${M.canShare?`<button class="btn sec" data-act="sharefile">Поделиться / сохранить в Файлы</button>`:""}
    </div>
    <div class="mrow"><button class="btn ghost" data-act="close">Закрыть</button></div>`;
  }
  if(M.type==="pw"){
    body=`<h3>${esc(M.title)}</h3><p>Передайте сотруднику ссылку, логин и временный пароль. При первом входе он задаст свой пароль.</p>
    <div class="pwbox"><div><span class="muted">Логин</span><b>${esc(M.login)}</b></div><div><span class="muted">Временный пароль</span><b>${esc(M.pw)}</b></div></div>
    <div class="mrow"><button class="btn sec" data-act="copypw">Скопировать</button><button class="btn pri" data-act="close">Готово</button></div>`;
  }
  return `<div class="ov" data-act="ovclose"><div class="modal" role="dialog" aria-modal="true">${body}</div></div>`;
}

let tt;
function toast(t){st.toast=t;clearTimeout(tt);const el=$(".toast");if(el)el.textContent=t;else{const d=document.createElement("div");d.className="toast";d.setAttribute("role","status");d.textContent=t;document.body.appendChild(d);}tt=setTimeout(()=>{st.toast=null;document.querySelectorAll(".toast").forEach(x=>x.remove());},4000);}
function keepM(){if(!st.modal)return;const g=id=>{const e=document.getElementById(id);return e?e.value:undefined;};
  const c=g("mc");if(c!==undefined)st.modal.c=c;const k=g("nk");if(k!==undefined)st.modal.kind=k;const cl=g("ncl");if(cl!==undefined)st.modal.client=cl;
  const n=g("un");if(n!==undefined)st.modal.name=n;const l=g("ul");if(l!==undefined)st.modal.login=l;const r=g("ur");if(r!==undefined)st.modal.role=r;}
function openReq(id){
  st.view="list"; st.sel=id; st.detail=true; st.draft=""; st.pend=null; st.pendObj=null; st.msgs=[];
  watchMsgs(id); render();
}
function logout(){unsubscribeAll();if(msgRef)msgRef.off("value",msgH);msgRef=null;auth.signOut();Object.assign(st,{authMode:"login",tab:"sent_acc",mgrF:null,sel:null,detail:false,modal:null,reqs:[],users:[],msgs:[],me:null,uid:null,ready:false,login:{}});render();}

/* ---------- события ---------- */
document.addEventListener("submit",async e=>{
  e.preventDefault();
  const f=e.target.dataset.form;
  if(f==="login"){
    const u=$("#lu").value.trim().toLowerCase(), p=$("#lp").value;
    st.login={u}; st.busy=true; render();
    try{await auth.signInWithEmailAndPassword(u.includes("@")?u:u+"@"+DOMAIN,p);}catch(err){st.login={u,err:errText(err)};}
    st.busy=false; render();
  }
  if(f==="forgot"){
    const em=$("#fe").value.trim().toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){st.login={u:em,err:"Введите почту полностью, например name@gmail.com"};render();return;}
    if(em.endsWith("@"+DOMAIN)){st.login={u:em,err:"У этой учётной записи нет настоящей почты. Пароль сбросит руководитель."};render();return;}
    st.busy=true; render();
    try{await auth.sendPasswordResetEmail(em); st.login={u:em,sent:true};}
    catch(err){ if(err&&err.code==="auth/user-not-found") st.login={u:em,sent:true}; else st.login={u:em,err:errText(err)}; }
    st.busy=false; render(); return;
  }
  if(f==="chpw"){
    const p1=$("#p1").value,p2=$("#p2").value;
    if(p1.length<8){st.login={err:"Пароль должен быть не короче 8 символов"};render();return;}
    if(p1!==p2){st.login={err:"Пароли не совпадают"};render();return;}
    st.busy=true; render();
    try{await auth.currentUser.updatePassword(p1); await db.ref("users/"+st.uid+"/must_change_pw").set(false); st.login={};}
    catch(err){st.login={err:errText(err)};}
    st.busy=false; render();
  }
});

document.addEventListener("click",async e=>{
  const el=e.target.closest("[data-act]"); if(!el) return;
  const act=el.dataset.act;
  if(act==="ovclose"&&e.target!==el) return;
  const r=st.reqs.find(x=>x.id===st.sel);
  try{
  switch(act){
    case "logout": logout(); return;
    case "notif": try{await Notification.requestPermission();}catch(x){} break;
    case "view": st.view=el.dataset.v; st.detail=false; break;
    case "tab": st.tab=el.dataset.t; break;
    case "mgrclear": st.mgrF=null; break;
    case "forgot": st.authMode="forgot"; st.login={u:($("#lu")||{}).value||""}; break;
    case "tologin": st.authMode="login"; st.login={}; break;
    case "goto": { const f=el.dataset.f; st.view="list"; st.sel=null; st.detail=false;
      if(f.startsWith("s:")){st.tab=f.slice(2);st.mgrF=null;} else if(f.startsWith("m:")){st.mgrF=f.slice(2);} break; }
    case "open": return openReq(el.dataset.id);
    case "openfrom": { const rr=st.reqs.find(x=>x.id===el.dataset.id); if(rr) st.tab=rr.status; st.mgrF=null; return openReq(el.dataset.id); }
    case "back": st.detail=false; break;
    case "new": st.modal={type:"new"}; st.focus="#nr"; break;
    case "act": st.modal={type:"act",a:actionsFor(r).find(a=>a.id===el.dataset.a)}; st.focus="#mc"; break;
    case "close": case "ovclose": if(!st.busy) st.modal=null; break;
    case "confirm": {
      keepM(); const M=st.modal, a=M.a, c=(M.c||"").trim();
      if(a.cmt==="req"&&!c){M.err="Добавьте комментарий: без него вторая сторона не поймёт, что нужно сделать.";break;}
      if(a.file==="req"&&!M.fileObj){M.err="Приложите файл документа.";break;}
      st.busy=true; render();
      try{const file=M.fileObj?await saveFile(M.fileObj,r.id):null; await transition(r,a,c,file); st.modal=null;}
      catch(err){M.err=errText(err);}
      st.busy=false; break;}
    case "create": {
      keepM(); const M=st.modal; const kind=(M.kind||"").trim(), cl=(M.client||"").trim(), cm=(M.c||"").trim();
      if(!kind||!cl||!cm){M.err="Заполните вид запроса, клиента и комментарий.";break;}
      st.busy=true; render();
      try{
        const res=await db.ref("meta/next_no").transaction(v=>(v||1000)+1);
        const no=res.snapshot.val();
        const ref=db.ref("requests").push();
        const invoice=M.fileObj?await saveFile(M.fileObj,ref.key):null;
        await ref.set({no,kind,client:cl,comment:cm,invoice,mgr:st.uid,acc:"",status:"sent_acc",returns:0,created:TS,last_change:TS,last_msg:TS,last_msg_by:st.uid});
        await addMsg(ref.key,{sys:true,status:"sent_acc"});
        st.modal=null; st.busy=false; st.tab="sent_acc"; st.mgrF=null; toast("Заявка #"+no+" отправлена в бухгалтерию");
        return openReq(ref.key);
      }catch(err){M.err=errText(err);}
      st.busy=false; break;}
    case "sendmsg": {
      const ta=$("#draft"); const t=(ta?ta.value:"").trim();
      if(!t&&!st.pendObj) return;
      st.busy=true;
      try{
        const file=st.pendObj?await saveFile(st.pendObj,r.id):null;
        await addMsg(r.id,{text:t,file});
        await db.ref("requests/"+r.id).update({last_msg:TS,last_msg_by:st.uid});
        st.draft=""; st.pend=null; st.pendObj=null;
      }catch(err){toast("Сообщение не отправлено: "+errText(err));}
      st.busy=false; break;}
    case "unpend": st.pend=null; st.pendObj=null; break;
    case "file": openFile({id:el.dataset.fid}); return;
    case "sharefile": try{await navigator.share({files:[st.modal.fileObj],title:st.modal.name});}catch(x){if(x&&x.name!=="AbortError")toast("Не удалось поделиться файлом");} return;
    case "adduser": st.modal={type:"adduser",role:"mgr"}; st.focus="#un"; break;
    case "saveuser": {
      keepM(); const M=st.modal, name=(M.name||"").trim(), login=(M.login||"").trim().toLowerCase();
      const isHead=(M.role||"mgr")==="head";
      if(!name||!login){M.err=isHead?"Заполните ФИО и почту.":"Заполните ФИО и логин.";break;}
      if(isHead&&!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(login)){M.err="Укажите настоящую почту руководителя, например name@gmail.com.";break;}
      if(!isHead&&!/^[a-z0-9._-]{3,}$/.test(login)){M.err="Логин: латинские буквы, цифры, точка, дефис; минимум 3 символа.";break;}
      const pw=genPw(); st.busy=true; render();
      // отдельный экземпляр Firebase, чтобы руководителя не «разлогинило» при создании учётки
      const sec=firebase.initializeApp(window.FIREBASE_CONFIG,"creator-"+Date.now());
      try{
        const cred=await sec.auth().createUserWithEmailAndPassword(isHead?login:login+"@"+DOMAIN,pw);
        await db.ref("users/"+cred.user.uid).set({name,username:login,role:M.role||"mgr",active:true,must_change_pw:true});
        st.modal={type:"pw",title:"Сотрудник добавлен",login,pw};
      }catch(err){M.err=errText(err);}
      try{await sec.auth().signOut();await sec.delete();}catch(x){}
      st.busy=false; break;}
    case "copypw": try{await navigator.clipboard.writeText("Ссылка: "+location.origin+"\nЛогин: "+st.modal.login+"\nВременный пароль: "+st.modal.pw);toast("Скопировано");}catch(x){toast("Не удалось скопировать, перепишите вручную");} return;
    case "block": {
      const x=user(el.dataset.id);
      await db.ref("users/"+x.id+"/active").set(!x.active);
      toast(x.active?x.name+" заблокирован. Его заявки и переписка остаются в архиве.":x.name+" разблокирован"); break;}
  }
  }catch(err){st.busy=false; toast(errText(err));}
  render();
});
document.addEventListener("input",e=>{
  const on=e.target.dataset.on;
  if(on==="q"){st.q=e.target.value;render();}
  if(on==="draft"){st.draft=e.target.value;}

});
document.addEventListener("change",e=>{
  const on=e.target.dataset.on;
  if(on==="urole"){keepM();st.modal.login="";st.modal.err=null;render();return;}
  if(on==="mfile"||on==="chatfile"){
    const f=e.target.files&&e.target.files[0]; if(!f) return;
    if(f.size>MAX_FILE){toast("В тестовой версии файл должен быть не больше 5 МБ");return;}
    if(on==="mfile"){keepM();st.modal.file={name:f.name,size:f.size};st.modal.fileObj=f;st.modal.err=null;}
    else{st.draft=($("#draft")||{}).value||st.draft;st.pend={name:f.name,size:f.size};st.pendObj=f;}
    render();
  }
});
document.addEventListener("keydown",e=>{
  if(e.target.id==="draft"&&e.key==="Enter"&&!e.shiftKey&&window.matchMedia("(min-width: 861px)").matches){e.preventDefault();const b=$('[data-act="sendmsg"]');if(b)b.click();}
  if(e.key==="Escape"&&st.modal&&!st.busy){st.modal=null;render();}
});
document.addEventListener("visibilitychange",()=>{if(!document.hidden){markSeenIfOpen();if(st.ready)render();}});

auth.onAuthStateChanged(async u=>{
  if(!u){st.uid=null;st.me=null;render();return;}
  st.uid=u.uid; render();
  try{
    const s=await db.ref("users/"+u.uid).once("value"); const v=s.val();
    if(!v){toast("Учётная запись не настроена: нет записи в users. См. инструкцию.");logout();return;}
    if(!v.active){logout();st.login={err:"Учётная запись заблокирована. Обратитесь к руководителю."};render();return;}
    st.me=Object.assign({id:u.uid},v);
    startData();
  }catch(e){toast(errText(e));logout();}
});
if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
render();
})();
