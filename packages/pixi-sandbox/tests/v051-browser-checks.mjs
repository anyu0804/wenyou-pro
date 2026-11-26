import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function check051(page, exportProject, active, evidenceRoot) {
  const checks = [];
  await exportProject();
  assert.equal(await page.locator('[data-view="religion"], [data-tool="brush-height"], [data-tool="brush-religion"]').count(), 0);
  assert.ok(!(await page.locator('#wenyou-brush-panel').innerText()).match(/高度增量|信仰/));
  checks.push('四视图四工具；高度与宗教 UI 下线');
  const tiers = [[500,'|','连'],[2000,'||','营'],[6000,'|||','团'],[18000,'x','师'],
    [54000,'xx','军'],[150000,'xxx','集团军'],[450000,'xxxx','方面军'],[450001,'xxxx','方面军']];
  const created = [];
  await page.locator('#garrison-style').selectOption('minimal');
  await page.locator('#garrison-scale').evaluate(el=>{el.value='1';});
  await page.locator('#garrison-scale').dispatchEvent('input');
  for (let i=0;i<tiers.length;i++) {
    const [count,symbol,echelon] = tiers[i];
    await page.locator('#btn-open-garrison-custom').click();
    await page.locator('#modal-unit-select').selectOption('');
    await page.locator('#modal-name-input').fill(`G2-${i+1}`);
    await page.locator('#modal-troops-input').fill(String(count));
    assert.equal(await page.locator('#modal-echelon-input').inputValue(), echelon);
    assert.ok((await page.locator('#modal-echelon-preview-badge').innerText()).includes(`[${symbol}]`));
    await page.locator('#modal-save-btn').click();
    await page.locator('#garrison-custom-modal').waitFor({state:'detached'});
    const archive = await exportProject();
    const state = active(archive);
    const unit = state.garrisons.find(u => u.unitName.value === `G2-${i+1}`);
    assert.equal(unit.personnel.count.value,count);
    const before = state.battle.deployments.find(d=>d.unitId===unit.id).placement.value.anchor;
    const target = [520+i*65, 680];
    await page.mouse.move(800,500); await page.mouse.down();
    await page.mouse.move(...target,{steps:5}); await page.mouse.up();
    const moved = active(await exportProject()).battle.deployments.find(d=>d.unitId===unit.id).placement.value.anchor;
    assert.notDeepEqual(moved,before,'主地图拖动必须修改实际部署');
    created.push({id:unit.id,count,symbol,echelon,screen:target});
  }
  await page.screenshot({path:path.join(evidenceRoot,'eight-tiers.png')});
  checks.push('8人数区间/7军标；快速新建与真实主地图拖动');
  const chosen=created[0];
  await page.mouse.click(...chosen.screen);
  await page.locator('#garrison-custom-modal').waitFor();
  assert.equal(await page.locator('#modal-unit-select').inputValue(),chosen.id);
  // 文化样式下拉与战术图腾关键词已按改版下线；验证字体颜色、中心字与自定义图片上传
  await page.locator('#modal-text-color-input').fill('#fde047');
  await page.locator('#modal-glyph-input').fill('禁军');
  await page.screenshot({path:path.join(evidenceRoot,'customize-tag-glyph.png')});
  const png=await page.evaluate(()=>{
    const c=document.createElement('canvas'); c.width=c.height=24;
    const ctx=c.getContext('2d'); ctx.fillStyle='#00ffff';ctx.fillRect(0,0,24,24);
    ctx.fillStyle='#ff00ff';ctx.fillRect(5,5,14,14);return c.toDataURL('image/png');
  });
  await page.locator('#modal-icon-file').setInputFiles({name:'g2-icon.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
  await page.waitForFunction(()=>document.querySelector('#modal-dataurl-input').value.startsWith('data:image/png'));
  await page.locator('#modal-save-btn').click();
  await page.locator('#garrison-custom-modal').waitFor({state:'detached'});
  const customized=active(await exportProject()).garrisons.find(u=>u.id===chosen.id);
  assert.equal(customized.customBadge.textColor,'#fde047');
  assert.equal(customized.customBadge.customIconDataUrl,png);
  assert.equal(customized.customBadge.culture,'universal'); // 文化下拉已按 2026-10-22 改版隐藏，保持默认值
  await page.screenshot({path:path.join(evidenceRoot,'custom-image-main.png')});
  await page.reload();await page.locator('#battle-open').waitFor();
  assert.deepEqual(active(await exportProject()).garrisons.find(u=>u.id===chosen.id).customBadge,customized.customBadge);
  await page.locator('#battle-open').click();
  await page.screenshot({path:path.join(evidenceRoot,'custom-image-battle.png')});
  await page.locator('#battle-close').click();
  checks.push('字体颜色/中心字/真实图片上传；工程导出及刷新持久化（文化样式与战术图腾已按改版下线）');
  // 从实际 15px 笔迹的地图长度反推倍率；不向生产 bundle 注入测试接口。
  const observed=[];
  for(const n of [5,18,40]) {
    await page.locator('[data-mode="pan"]').click();
    await page.locator('canvas').first().evaluate((c,n)=>{
      for(let i=0;i<n;i++) c.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,clientX:800,clientY:700,cancelable:true}));
    },n);
    const before=active(await exportProject()).tacticalItems.length;
    await page.locator('[data-mode="tactical-frontline"]').click();
    await page.mouse.move(800,700);await page.mouse.down();
    await page.mouse.move(815,700,{steps:3});await page.mouse.up();
    const items=active(await exportProject()).tacticalItems;
    assert.equal(items.length,before+1,'15px 战线应一次成线');
    const points=items.at(-1).points;
    const first=points[0],last=points.at(-1);
    observed.push(15/Math.hypot(last[0]-first[0],last[1]-first[1]));
    await page.screenshot({path:path.join(evidenceRoot,`frontline-${observed.length}.png`)});
  }
  assert.ok(Math.abs(observed.at(-1)-32)<0.01);
  checks.push('生产包三档倍率 15px 单次成线（末档32倍）');
  return {checks,tiers:created,frontlineScales:observed};
}
