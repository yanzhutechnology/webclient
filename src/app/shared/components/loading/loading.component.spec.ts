import { async, ComponentFixture, TestBed } from '@angular/core/testing';
import { SafePipe } from '../../pipes/safe.pipe';

import { LoadingComponent } from './loading.component';

describe('LoadingComponent', () => {
  let component: LoadingComponent;
  let fixture: ComponentFixture<LoadingComponent>;

  beforeEach((() => {
    TestBed.configureTestingModule({
      declarations: [LoadingComponent],
      imports: [SafePipe]
    }).compileComponents();
  }));

  beforeEach(() => {
    fixture = TestBed.createComponent(LoadingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
