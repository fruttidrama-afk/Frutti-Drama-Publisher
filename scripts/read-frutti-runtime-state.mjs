import { DatabaseSync } from 'node:sqlite';
const db=new DatabaseSync('/tmp/frutti-state/publisher-runtime/factory.sqlite',{readOnly:true});
for(const table of ['factory_items','factory_generations','publication_items']){
  try{
    const rows=db.prepare('select * from '+table+' order by rowid desc limit 40').all();
    console.log(table.toUpperCase(),JSON.stringify(rows));
  }catch(e){
    console.log(table.toUpperCase()+'_ERROR',String(e.message||e));
  }
}
db.close();
