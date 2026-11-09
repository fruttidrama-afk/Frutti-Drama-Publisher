// Touch navigation overlay for the operator's iPad, served by noVNC itself.
// It uses noVNC's existing authenticated RFB websocket and only sends pointer
// wheel events / page navigation keys. NO external traffic or Google secrets.
import UI from './ui.js';

function install(){
 if(document.getElementById('fruttiTouchNav'))return;
 const css=document.createElement('style');
 css.textContent=`
 #fruttiTouchNav{position:fixed;right:max(8px,env(safe-area-inset-right));top:34%;z-index:2147483646;
 display:flex;flex-direction:column;gap:7px;align-items:stretch;max-width:155px;
 font:600 14px -apple-system,BlinkMacSystemFont,Arial,sans-serif;}
 #fruttiTouchNav button{font:inherit;min-height:46px;border-radius:12px;border:1px solid #ccc;
 box-shadow:0 3px 15px #0005;background:#113a61;color:#fff;padding:8px 11px;
 -webkit-tap-highlight-color:transparent;touch-action:manipulation;cursor:pointer}
 #fruttiTouchNav button.active{background:#0b6a4b}
 #fruttiTouchNav .small{font-size:12px;min-height:37px;}
 #fruttiTouchScrollCapture{position:fixed;inset:0;z-index:2147483645;background:transparent;
 touch-action:none;display:none;}
 `;
 document.head.append(css);
 const panel=document.createElement('div');panel.id='fruttiTouchNav';
 const toggle=document.createElement('button');toggle.type='button';toggle.textContent='☝️ DESLIZAR';toggle.setAttribute('aria-label','Activar desplazamiento con un dedo');
 const up=document.createElement('button');up.type='button';up.className='small';up.textContent='▲ SUBIR';
 const down=document.createElement('button');down.type='button';down.className='small';down.textContent='▼ BAJAR';
 const overlay=document.createElement('div');overlay.id='fruttiTouchScrollCapture';
 panel.append(toggle,up,down);
 document.body.append(overlay,panel);
 let enabled=false,prevY=null;
 const rfb=()=>UI.rfb;
 function scroll(delta,clientX,clientY){
  const canvas=document.querySelector('#noVNC_canvas')||document.querySelector('#noVNC_container canvas');
  if(!canvas||!rfb())return;
  const r=canvas.getBoundingClientRect();
  canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,
   deltaMode:0,deltaX:0,deltaY:delta,
   clientX:Math.max(r.left+2,Math.min(r.right-2,clientX||r.left+r.width/2)),
   clientY:Math.max(r.top+2,Math.min(r.bottom-2,clientY||r.top+r.height/2))}));
 }
 function setMode(value){
  enabled=value;prevY=null;overlay.style.display=enabled?'block':'none';
  toggle.classList.toggle('active',enabled);
  toggle.textContent=enabled?'✓ DESLIZAR ON':'☝️ DESLIZAR';
  toggle.setAttribute('aria-label',enabled?'Desactivar desplazamiento para volver a tocar el escritorio':'Activar desplazamiento con un dedo');
 }
 toggle.addEventListener('click',()=>setMode(!enabled));
 overlay.addEventListener('touchstart',event=>{
  if(!enabled||!event.touches.length)return;
  prevY=event.touches[0].clientY;event.preventDefault();
 },{passive:false});
 overlay.addEventListener('touchmove',event=>{
  if(!enabled||!event.touches.length)return;
  const t=event.touches[0];
  if(prevY!==null){
   const dy=t.clientY-prevY;
   // Drag up => scroll remote document down. One VNC wheel step per ~50 px.
   if(Math.abs(dy)>=3){scroll(-dy*3,t.clientX,t.clientY);prevY=t.clientY;}
  }
  event.preventDefault();
 },{passive:false});
 overlay.addEventListener('touchend',event=>{prevY=null;event.preventDefault()},{passive:false});
 function pageKey(keysym,code){const c=rfb();if(c)c.sendKey(keysym,code);}
 // Page keys are supported by the public noVNC API as a fallback if wheel
 // events are intercepted by iOS or the remote application.
 up.addEventListener('click',()=>pageKey(0xFF55,'PageUp'));
 down.addEventListener('click',()=>pageKey(0xFF56,'PageDown'));
 // Do not prevent noVNC's native two-finger scroll when scroll mode is off.
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});
else install();
