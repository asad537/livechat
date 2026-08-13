import { io } from 'socket.io-client';
const BASE='http://localhost:4000';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const s=io(BASE+'/widget',{auth:{
  widgetKey:'wk_acme_demo',
  page:'https://acme-store.test/custom-mailer-boxes',
  pageTitle:'Custom Mailer Boxes',
  referrer:'https://www.google.com/',
},transports:['websocket']});
s.on('connect_error',e=>{console.log('connect_error:',e.message);process.exit(1);});
s.on('widget:ready',p=>{
  console.log('visitor online:', p.visitor?.id);
  s.emit('widget:info',{name:'Demo Visitor',email:'demo.visitor@test.com'});
  console.log('named "Demo Visitor" — ab Visitors page pe Online now me dikhega');
});
// activity ping so idle detection never kicks in while demoing
setInterval(()=>s.emit('widget:activity',{active:true}), 5*60*1000);
// stay alive 30 minutes then exit
await sleep(30*60*1000);
process.exit(0);
