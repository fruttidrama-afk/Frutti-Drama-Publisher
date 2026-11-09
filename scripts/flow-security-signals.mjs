/**
 * Conservative, read-only classification of Google sign-in and Flow
 * anti-abuse UI signals. Signals are NOT instructions to retry a login,
 * solve CAPTCHA, switch IP/network, or send another Generate.
 * Never log the HTML/body or any session tokens.
 */
export function classifyFlowSecuritySignal(url='',body=''){
  const u=String(url||'').slice(0,2000);
  const t=String(body||'').slice(0,18000);
  if(/we noticed (?:some )?unusual activity|we've noticed unusual activity|hemos detectado actividad inusual|detectamos actividad inusual|actividad inusual/i.test(t)){
    return 'unusual_activity';
  }
  const challenge=/(?:verify it['’]?s you|confirm (?:your )?identity|security check|security verification|verify your identity|2-step verification|two.step verification|enter (?:a |the )?verification code|complete the captcha|verific[aá] que eres t[uú]|verifica tu identidad|verificaci[oó]n de seguridad|c[oó]digo de verificaci[oó]n|comprobaci[oó]n de seguridad|confirma que eres t[uú])/i;
  if(challenge.test(t)||(/accounts\.google\.com/i.test(u)&&/\/challenge\b|\/signin\/v2\/challenge\b/i.test(u))){
    return 'security_challenge';
  }
  if(/accounts\.google\.com|ServiceLogin|signin\/v2|\/about(?:$|[?#])/i.test(u)||
     /(?:email or phone|enter your password|sign in to continue|iniciar sesi[oó]n|accede a tu cuenta|elige una cuenta para continuar)/i.test(t)){
    return 'login_required';
  }
  return null;
}
